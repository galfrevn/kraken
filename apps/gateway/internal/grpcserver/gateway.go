package grpcserver

import (
	"context"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	agentv1 "kraken/gen/go/agent/v1"
	"kraken/gen/go/agent/v1/agentv1connect"
	"kraken/apps/gateway/internal/llm"
	"kraken/apps/gateway/internal/webhooks"
)

type GatewayServer struct {
	llmClient    *llm.Client
	webhookStore *webhooks.Store
	eventChannel webhooks.EventChannel
	logger       *slog.Logger
}

var _ agentv1connect.GatewayServiceHandler = (*GatewayServer)(nil)

func NewGatewayServer(
	llmClient *llm.Client,
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

func (s *GatewayServer) Complete(
	ctx context.Context,
	req *connect.Request[agentv1.CompleteRequest],
) (*connect.Response[agentv1.CompleteResponse], error) {
	s.logger.Info("complete request", "model", req.Msg.Model, "messages", len(req.Msg.Messages))

	messages := make([]llm.ChatMessage, len(req.Msg.Messages))
	for i, msg := range req.Msg.Messages {
		messages[i] = llm.ChatMessage{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

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
	}

	result, err := s.llmClient.Complete(ctx, llmReq)
	if err != nil {
		s.logger.Error("llm completion failed", "error", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("llm completion failed: %w", err))
	}

	if len(result.Choices) == 0 {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("no choices in response"))
	}

	resp := &agentv1.CompleteResponse{
		Id:    result.ID,
		Model: result.Model,
		Message: &agentv1.ChatMessage{
			Role:    result.Choices[0].Message.Role,
			Content: result.Choices[0].Message.Content,
		},
		PromptTokens:     result.Usage.PromptTokens,
		CompletionTokens: result.Usage.CompletionTokens,
	}

	return connect.NewResponse(resp), nil
}

func (s *GatewayServer) StreamComplete(
	ctx context.Context,
	req *connect.Request[agentv1.StreamCompleteRequest],
	stream *connect.ServerStream[agentv1.StreamCompleteResponse],
) error {
	s.logger.Info("stream complete request", "model", req.Msg.Model, "messages", len(req.Msg.Messages))

	messages := make([]llm.ChatMessage, len(req.Msg.Messages))
	for i, msg := range req.Msg.Messages {
		messages[i] = llm.ChatMessage{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

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
	}

	var streamID string

	err := s.llmClient.StreamComplete(ctx, llmReq, func(chunk llm.StreamChunk) error {
		if streamID == "" {
			streamID = chunk.ID
		}

		delta := ""
		done := false

		if len(chunk.Choices) > 0 {
			delta = chunk.Choices[0].Delta.Content
			if chunk.Choices[0].FinishReason != nil {
				done = true
			}
		}

		resp := &agentv1.StreamCompleteResponse{
			Id:    streamID,
			Delta: delta,
			Done:  done,
		}

		if chunk.Usage != nil {
			resp.PromptTokens = chunk.Usage.PromptTokens
			resp.CompletionTokens = chunk.Usage.CompletionTokens
		}

		return stream.Send(resp)
	})

	if err != nil {
		s.logger.Error("stream complete failed", "error", err)
		return connect.NewError(connect.CodeInternal, fmt.Errorf("stream complete failed: %w", err))
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
