package grpcserver

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	agentv1 "kraken/gen/go/agent/v1"
	"kraken/gen/go/agent/v1/agentv1connect"
	"kraken/apps/gateway/internal/llm"
	"kraken/apps/gateway/internal/webhooks"
)

type GatewayServer struct {
	llmClient    llm.LLMClient
	webhookStore *webhooks.Store
	eventChannel webhooks.EventChannel
	logger       *slog.Logger
}

var _ agentv1connect.GatewayServiceHandler = (*GatewayServer)(nil)

func NewGatewayServer(
	llmClient llm.LLMClient,
	webhookStore *webhooks.Store,
	eventChannel webhooks.EventChannel,
	logger *slog.Logger,
) *GatewayServer {
	return &GatewayServer{
		llmClient:    llmClient,
		webhookStore: webhookStore,
		eventChannel: eventChannel,
		logger:       logger,
	}
}

func protoToolsToLLM(protoTools []*agentv1.Tool) []llm.Tool {
	if len(protoTools) == 0 {
		return nil
	}
	tools := make([]llm.Tool, len(protoTools))
	for i, pt := range protoTools {
		t := llm.Tool{Type: pt.Type}
		if pt.Function != nil {
			t.Function = llm.ToolFunction{
				Name:        pt.Function.Name,
				Description: pt.Function.Description,
			}
			if pt.Function.Parameters != nil {
				params := map[string]interface{}{
					"type":     pt.Function.Parameters.Type,
					"required": pt.Function.Parameters.Required,
				}
				if pt.Function.Parameters.PropertiesJson != "" {
					var props interface{}
					if err := json.Unmarshal([]byte(pt.Function.Parameters.PropertiesJson), &props); err == nil {
						params["properties"] = props
					}
				}
				t.Function.Parameters = params
			}
		}
		tools[i] = t
	}
	return tools
}

func protoMessagesToLLM(protoMsgs []*agentv1.ChatMessage) []llm.ChatMessage {
	msgs := make([]llm.ChatMessage, 0, len(protoMsgs))
	for _, msg := range protoMsgs {
		// Tool result messages without a tool_call_id are invalid for all providers
		// (Anthropic, OpenAI, OpenRouter all require it). Convert to a plain user
		// message so the conversation history remains usable.
		if msg.Role == "tool" && msg.ToolCallId == "" {
			content := msg.Content
			if msg.Name != nil && *msg.Name != "" {
				content = "[" + *msg.Name + "] " + content
			}
			msgs = append(msgs, llm.ChatMessage{
				Role:    "user",
				Content: content,
			})
			continue
		}

		m := llm.ChatMessage{
			Role:       msg.Role,
			Content:    msg.Content,
			ToolCallID: msg.ToolCallId,
		}
		if msg.Name != nil {
			m.Name = *msg.Name
		}
		if len(msg.ToolCalls) > 0 {
			m.ToolCalls = make([]llm.ToolCallEntry, len(msg.ToolCalls))
			for j, tc := range msg.ToolCalls {
				m.ToolCalls[j] = llm.ToolCallEntry{
					ID:   tc.Id,
					Type: tc.Type,
				}
				if tc.Function != nil {
					m.ToolCalls[j].Function = llm.ToolCallFunction{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					}
				}
			}
		}
		msgs = append(msgs, m)
	}
	return msgs
}

func llmToolCallsToProto(toolCalls []llm.ToolCallEntry) []*agentv1.ToolCallEntry {
	if len(toolCalls) == 0 {
		return nil
	}
	result := make([]*agentv1.ToolCallEntry, len(toolCalls))
	for i, tc := range toolCalls {
		result[i] = &agentv1.ToolCallEntry{
			Id:   tc.ID,
			Type: tc.Type,
			Function: &agentv1.ToolCallFunction{
				Name:      tc.Function.Name,
				Arguments: tc.Function.Arguments,
			},
		}
	}
	return result
}

func (s *GatewayServer) Complete(
	ctx context.Context,
	req *connect.Request[agentv1.CompleteRequest],
) (*connect.Response[agentv1.CompleteResponse], error) {
	s.logger.Info("complete request", "model", req.Msg.Model, "messages", len(req.Msg.Messages))

	messages := protoMessagesToLLM(req.Msg.Messages)

	if req.Msg.SystemPrompt != nil {
		messages = append([]llm.ChatMessage{{
			Role:    "system",
			Content: *req.Msg.SystemPrompt,
		}}, messages...)
	}

	llmReq := llm.CompletionRequest{
		Model:       req.Msg.Model,
		Messages:    messages,
		Temperature: req.Msg.Temperature,
		MaxTokens:   req.Msg.MaxTokens,
		Tools:       protoToolsToLLM(req.Msg.Tools),
	}

	result, err := s.llmClient.Complete(ctx, llmReq)
	if err != nil {
		s.logger.Error("llm completion failed", "error", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("llm completion failed: %w", err))
	}

	if len(result.Choices) == 0 {
		s.logger.Error("no choices in response", "model", req.Msg.Model, "response_id", result.ID, "response_model", result.Model, "prompt_tokens", result.Usage.PromptTokens, "completion_tokens", result.Usage.CompletionTokens)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("no choices in response (model=%s, id=%s)", req.Msg.Model, result.ID))
	}

	choice := result.Choices[0]

	// Detect empty responses: no content, no tool calls, no finish reason
	if choice.Message.Content == "" && len(choice.Message.ToolCalls) == 0 && choice.FinishReason == "" {
		s.logger.Error("empty response from provider", "model", req.Msg.Model, "response_id", result.ID, "prompt_tokens", result.Usage.PromptTokens, "completion_tokens", result.Usage.CompletionTokens, "finish_reason", choice.FinishReason)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("empty response from provider (model=%s, id=%s, promptTokens=%d, completionTokens=%d)", req.Msg.Model, result.ID, result.Usage.PromptTokens, result.Usage.CompletionTokens))
	}

	resp := &agentv1.CompleteResponse{
		Id:    result.ID,
		Model: result.Model,
		Message: &agentv1.ChatMessage{
			Role:    choice.Message.Role,
			Content: choice.Message.Content,
		},
		PromptTokens:     result.Usage.PromptTokens,
		CompletionTokens: result.Usage.CompletionTokens,
		ToolCalls:        llmToolCallsToProto(choice.Message.ToolCalls),
		FinishReason:     choice.FinishReason,
	}

	return connect.NewResponse(resp), nil
}

func (s *GatewayServer) StreamComplete(
	ctx context.Context,
	req *connect.Request[agentv1.StreamCompleteRequest],
	stream *connect.ServerStream[agentv1.StreamCompleteResponse],
) error {
	s.logger.Info("stream complete request", "model", req.Msg.Model, "messages", len(req.Msg.Messages))

	messages := protoMessagesToLLM(req.Msg.Messages)

	if req.Msg.SystemPrompt != nil {
		messages = append([]llm.ChatMessage{{
			Role:    "system",
			Content: *req.Msg.SystemPrompt,
		}}, messages...)
	}

	llmReq := llm.CompletionRequest{
		Model:       req.Msg.Model,
		Messages:    messages,
		Temperature: req.Msg.Temperature,
		MaxTokens:   req.Msg.MaxTokens,
		Tools:       protoToolsToLLM(req.Msg.Tools),
	}

	var streamID string
	accumulatedToolCalls := make(map[int]*llm.ToolCallEntry)
	var finishReason string

	err := s.llmClient.StreamComplete(ctx, llmReq, func(chunk llm.StreamChunk) error {
		if streamID == "" {
			streamID = chunk.ID
		}

		delta := ""
		reasoning := ""
		done := false

		if len(chunk.Choices) > 0 {
			choice := chunk.Choices[0]
			delta = choice.Delta.Content
			reasoning = choice.Delta.GetReasoning()

			for _, tcDelta := range choice.Delta.ToolCalls {
				existing, ok := accumulatedToolCalls[tcDelta.Index]
				if !ok {
					accumulatedToolCalls[tcDelta.Index] = &llm.ToolCallEntry{
						ID:   tcDelta.ID,
						Type: tcDelta.Type,
						Function: llm.ToolCallFunction{
							Name:      tcDelta.Function.Name,
							Arguments: tcDelta.Function.Arguments,
						},
					}
				} else {
					if tcDelta.ID != "" {
						existing.ID = tcDelta.ID
					}
					if tcDelta.Type != "" {
						existing.Type = tcDelta.Type
					}
					if tcDelta.Function.Name != "" {
						existing.Function.Name += tcDelta.Function.Name
					}
					existing.Function.Arguments += tcDelta.Function.Arguments
				}
			}

			if choice.FinishReason != nil {
				done = true
				finishReason = *choice.FinishReason
			}
		}

		resp := &agentv1.StreamCompleteResponse{
			Id:        streamID,
			Delta:     delta,
			Done:      done,
			Reasoning: reasoning,
		}

		if chunk.Usage != nil {
			resp.PromptTokens = chunk.Usage.PromptTokens
			resp.CompletionTokens = chunk.Usage.CompletionTokens
		}

		if done {
			resp.FinishReason = finishReason
			if len(accumulatedToolCalls) > 0 {
				toolCalls := make([]llm.ToolCallEntry, 0, len(accumulatedToolCalls))
				for i := 0; i < len(accumulatedToolCalls); i++ {
					if tc, ok := accumulatedToolCalls[i]; ok {
						toolCalls = append(toolCalls, *tc)
					}
				}
				resp.ToolCalls = llmToolCallsToProto(toolCalls)
			}
		}

		return stream.Send(resp)
	})

	if err != nil {
		s.logger.Error("stream complete failed", "model", req.Msg.Model, "messages", len(req.Msg.Messages), "error", err)
		return connect.NewError(connect.CodeInternal, fmt.Errorf("stream complete failed (model=%s): %w", req.Msg.Model, err))
	}

	return nil
}

func (s *GatewayServer) RegisterWebhook(
	ctx context.Context,
	req *connect.Request[agentv1.RegisterWebhookRequest],
) (*connect.Response[agentv1.RegisterWebhookResponse], error) {
	registration := s.webhookStore.Register(
		req.Msg.Name,
		req.Msg.Provider,
		req.Msg.Secret,
		req.Msg.Events,
	)

	s.logger.Info("webhook registered",
		"webhook_id", registration.ID,
		"name", registration.Name,
		"provider", registration.Provider,
	)

	return connect.NewResponse(&agentv1.RegisterWebhookResponse{
		WebhookId:   registration.ID,
		EndpointUrl: fmt.Sprintf("/webhooks/%s", registration.ID),
	}), nil
}

func (s *GatewayServer) UnregisterWebhook(
	ctx context.Context,
	req *connect.Request[agentv1.UnregisterWebhookRequest],
) (*connect.Response[agentv1.UnregisterWebhookResponse], error) {
	if s.webhookStore.Unregister(req.Msg.WebhookId) {
		s.logger.Info("webhook unregistered", "webhook_id", req.Msg.WebhookId)
		return connect.NewResponse(&agentv1.UnregisterWebhookResponse{}), nil
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("webhook not found: %s", req.Msg.WebhookId))
}

func (s *GatewayServer) ListWebhooks(
	ctx context.Context,
	req *connect.Request[agentv1.ListWebhooksRequest],
) (*connect.Response[agentv1.ListWebhooksResponse], error) {
	registrations := s.webhookStore.List()
	entries := make([]*agentv1.WebhookEntry, len(registrations))

	for i, reg := range registrations {
		entries[i] = &agentv1.WebhookEntry{
			WebhookId:   reg.ID,
			Name:        reg.Name,
			Provider:    reg.Provider,
			EndpointUrl: fmt.Sprintf("/webhooks/%s", reg.ID),
			Events:      reg.Events,
		}
	}

	return connect.NewResponse(&agentv1.ListWebhooksResponse{
		Webhooks: entries,
	}), nil
}

func (s *GatewayServer) StreamWebhookEvents(
	ctx context.Context,
	req *connect.Request[agentv1.StreamWebhookEventsRequest],
	stream *connect.ServerStream[agentv1.StreamWebhookEventsResponse],
) error {
	s.logger.Info("webhook event stream subscriber connected")

	for {
		select {
		case <-ctx.Done():
			s.logger.Info("webhook event stream subscriber disconnected")
			return nil
		case event := <-s.eventChannel:
			if err := stream.Send(&agentv1.StreamWebhookEventsResponse{
				Event: event,
			}); err != nil {
				return err
			}
		}
	}
}

func (s *GatewayServer) HealthCheck(
	ctx context.Context,
	req *connect.Request[agentv1.HealthCheckRequest],
) (*connect.Response[agentv1.HealthCheckResponse], error) {
	return connect.NewResponse(&agentv1.HealthCheckResponse{
		Healthy: true,
		Version: "0.1.0",
		Services: map[string]bool{
			"llm":      s.llmClient != nil,
			"webhooks": true,
		},
	}), nil
}
