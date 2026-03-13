package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	defaultAnthropicBaseURL = "https://api.anthropic.com/v1"
	anthropicVersion        = "2023-06-01"
)

// Anthropic API request/response types

type anthropicRequest struct {
	Model       string            `json:"model"`
	MaxTokens   int32             `json:"max_tokens"`
	System      string            `json:"system,omitempty"`
	Messages    []anthropicMsg    `json:"messages"`
	Temperature *float32          `json:"temperature,omitempty"`
	Tools       []anthropicTool   `json:"tools,omitempty"`
	Stream      bool              `json:"stream"`
}

type anthropicMsg struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"` // string or []anthropicContentBlock
}

type anthropicContentBlock struct {
	Type      string      `json:"type"`
	Text      string      `json:"text,omitempty"`
	ID        string      `json:"id,omitempty"`
	Name      string      `json:"name,omitempty"`
	Input     interface{} `json:"input,omitempty"`
	ToolUseID string      `json:"tool_use_id,omitempty"`
	Content   string      `json:"content,omitempty"`
}

type anthropicTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"input_schema"`
}

type anthropicResponse struct {
	ID         string                  `json:"id"`
	Type       string                  `json:"type"`
	Role       string                  `json:"role"`
	Content    []anthropicContentBlock `json:"content"`
	Model      string                  `json:"model"`
	StopReason string                  `json:"stop_reason"`
	Usage      anthropicUsage          `json:"usage"`
}

type anthropicUsage struct {
	InputTokens  int32 `json:"input_tokens"`
	OutputTokens int32 `json:"output_tokens"`
}

type anthropicErrorResponse struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Streaming types

type anthropicStreamEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"-"` // parsed from SSE data field
}

type anthropicMessageStart struct {
	Type    string `json:"type"`
	Message struct {
		ID    string `json:"id"`
		Model string `json:"model"`
	} `json:"message"`
}

type anthropicContentBlockStart struct {
	Type         string                `json:"type"`
	Index        int                   `json:"index"`
	ContentBlock anthropicContentBlock `json:"content_block"`
}

type anthropicContentBlockDelta struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
	Delta struct {
		Type           string `json:"type"`
		Text           string `json:"text,omitempty"`
		PartialJSON    string `json:"partial_json,omitempty"`
	} `json:"delta"`
}

type anthropicMessageDelta struct {
	Type  string `json:"type"`
	Delta struct {
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
	Usage *anthropicUsage `json:"usage,omitempty"`
}

// AnthropicClient implements the LLMClient interface for Anthropic's Messages API.
type AnthropicClient struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

// NewAnthropicClient creates a new Anthropic Messages API client.
func NewAnthropicClient(apiKey, baseURL string) *AnthropicClient {
	if baseURL == "" {
		baseURL = defaultAnthropicBaseURL
	}

	transport := &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		DisableCompression: false,
	}

	return &AnthropicClient{
		apiKey:  apiKey,
		baseURL: baseURL,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   5 * time.Minute,
		},
	}
}

// Complete sends a non-streaming completion request to Anthropic's Messages API.
func (c *AnthropicClient) Complete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	anthropicReq := c.buildRequest(req, false)

	body, err := json.Marshal(anthropicReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/messages", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	c.setHeaders(httpReq)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errResp anthropicErrorResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Error.Message != "" {
			return nil, fmt.Errorf("anthropic error: %s (type=%s)", errResp.Error.Message, errResp.Error.Type)
		}
		return nil, fmt.Errorf("anthropic returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var anthropicResp anthropicResponse
	if err := json.Unmarshal(respBody, &anthropicResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w (body: %.500s)", err, string(respBody))
	}

	return c.convertResponse(anthropicResp), nil
}

// StreamComplete sends a streaming completion request to Anthropic's Messages API.
func (c *AnthropicClient) StreamComplete(ctx context.Context, req CompletionRequest, callback StreamCallback) error {
	anthropicReq := c.buildRequest(req, true)

	body, err := json.Marshal(anthropicReq)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/messages", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	c.setHeaders(httpReq)
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		var errResp anthropicErrorResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Error.Message != "" {
			return fmt.Errorf("anthropic error: %s (type=%s)", errResp.Error.Message, errResp.Error.Type)
		}
		return fmt.Errorf("anthropic returned status %d: %s", resp.StatusCode, string(respBody))
	}

	return c.parseSSEStream(resp.Body, callback)
}

func (c *AnthropicClient) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", anthropicVersion)
}

func (c *AnthropicClient) buildRequest(req CompletionRequest, stream bool) anthropicRequest {
	maxTokens := int32(4096)
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		maxTokens = *req.MaxTokens
	}

	system, messages := c.convertMessages(req.Messages)

	anthropicReq := anthropicRequest{
		Model:       req.Model,
		MaxTokens:   maxTokens,
		System:      system,
		Messages:    messages,
		Temperature: req.Temperature,
		Stream:      stream,
	}

	if len(req.Tools) > 0 {
		anthropicReq.Tools = c.convertTools(req.Tools)
	}

	return anthropicReq
}

// convertMessages converts ChatMessage slice to Anthropic format, extracting system messages.
func (c *AnthropicClient) convertMessages(messages []ChatMessage) (string, []anthropicMsg) {
	var systemParts []string
	var result []anthropicMsg

	for _, msg := range messages {
		switch msg.Role {
		case "system":
			systemParts = append(systemParts, msg.Content)

		case "assistant":
			if len(msg.ToolCalls) > 0 {
				var blocks []anthropicContentBlock
				if msg.Content != "" {
					blocks = append(blocks, anthropicContentBlock{
						Type: "text",
						Text: msg.Content,
					})
				}
				for _, tc := range msg.ToolCalls {
					var input interface{}
					if tc.Function.Arguments != "" {
						_ = json.Unmarshal([]byte(tc.Function.Arguments), &input)
					}
					if input == nil {
						input = map[string]interface{}{}
					}
					blocks = append(blocks, anthropicContentBlock{
						Type:  "tool_use",
						ID:    tc.ID,
						Name:  tc.Function.Name,
						Input: input,
					})
				}
				result = append(result, anthropicMsg{
					Role:    "assistant",
					Content: blocks,
				})
			} else {
				result = append(result, anthropicMsg{
					Role:    "assistant",
					Content: msg.Content,
				})
			}

		case "tool":
			// Tool results must be sent as user messages with tool_result content blocks.
			// Try to merge with the previous message if it's also a user tool_result message.
			block := anthropicContentBlock{
				Type:      "tool_result",
				ToolUseID: msg.ToolCallID,
				Content:   msg.Content,
			}
			if len(result) > 0 {
				prev := &result[len(result)-1]
				if prev.Role == "user" {
					if prevBlocks, ok := prev.Content.([]anthropicContentBlock); ok {
						prev.Content = append(prevBlocks, block)
						continue
					}
				}
			}
			result = append(result, anthropicMsg{
				Role:    "user",
				Content: []anthropicContentBlock{block},
			})

		default: // "user"
			result = append(result, anthropicMsg{
				Role:    msg.Role,
				Content: msg.Content,
			})
		}
	}

	system := strings.Join(systemParts, "\n\n")
	return system, result
}

// convertTools converts OpenAI-style tools to Anthropic format.
func (c *AnthropicClient) convertTools(tools []Tool) []anthropicTool {
	result := make([]anthropicTool, len(tools))
	for i, t := range tools {
		result[i] = anthropicTool{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: t.Function.Parameters,
		}
	}
	return result
}

// convertResponse converts an Anthropic response to the shared CompletionResponse format.
func (c *AnthropicClient) convertResponse(resp anthropicResponse) *CompletionResponse {
	var content string
	var toolCalls []ToolCallEntry

	for _, block := range resp.Content {
		switch block.Type {
		case "text":
			content += block.Text
		case "tool_use":
			args, _ := json.Marshal(block.Input)
			toolCalls = append(toolCalls, ToolCallEntry{
				ID:   block.ID,
				Type: "function",
				Function: ToolCallFunction{
					Name:      block.Name,
					Arguments: string(args),
				},
			})
		}
	}

	finishReason := mapStopReason(resp.StopReason)

	return &CompletionResponse{
		ID:    resp.ID,
		Model: resp.Model,
		Choices: []CompletionChoice{
			{
				Message: ChatMessage{
					Role:      "assistant",
					Content:   content,
					ToolCalls: toolCalls,
				},
				FinishReason: finishReason,
			},
		},
		Usage: CompletionUsage{
			PromptTokens:     resp.Usage.InputTokens,
			CompletionTokens: resp.Usage.OutputTokens,
		},
	}
}

func mapStopReason(stopReason string) string {
	switch stopReason {
	case "tool_use":
		return "tool_calls"
	case "end_turn":
		return "stop"
	case "max_tokens":
		return "length"
	default:
		return stopReason
	}
}

// parseSSEStream reads Anthropic SSE events and emits StreamChunk values via callback.
func (c *AnthropicClient) parseSSEStream(body io.Reader, callback StreamCallback) error {
	scanner := bufio.NewScanner(body)
	chunksReceived := 0

	var msgID string
	var msgModel string

	// Track active tool_use blocks by index for argument accumulation
	type toolBlock struct {
		id   string
		name string
		args strings.Builder
	}
	activeTools := map[int]*toolBlock{}

	var currentEventType string

	for scanner.Scan() {
		line := scanner.Text()

		// Track event type from "event:" lines
		if strings.HasPrefix(line, "event: ") {
			currentEventType = strings.TrimPrefix(line, "event: ")
			continue
		}

		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")

		switch currentEventType {
		case "message_start":
			var ev anthropicMessageStart
			if err := json.Unmarshal([]byte(data), &ev); err == nil {
				msgID = ev.Message.ID
				msgModel = ev.Message.Model
			}

		case "content_block_start":
			var ev anthropicContentBlockStart
			if err := json.Unmarshal([]byte(data), &ev); err == nil {
				if ev.ContentBlock.Type == "tool_use" {
					activeTools[ev.Index] = &toolBlock{
						id:   ev.ContentBlock.ID,
						name: ev.ContentBlock.Name,
					}
					// Emit initial tool call chunk with name and ID
					chunk := StreamChunk{
						ID:    msgID,
						Model: msgModel,
						Choices: []StreamChoice{
							{
								Delta: StreamDelta{
									ToolCalls: []StreamToolCallDelta{
										{
											Index: ev.Index,
											ID:    ev.ContentBlock.ID,
											Type:  "function",
											Function: ToolCallFunction{
												Name: ev.ContentBlock.Name,
											},
										},
									},
								},
							},
						},
					}
					chunksReceived++
					if err := callback(chunk); err != nil {
						return err
					}
				}
			}

		case "content_block_delta":
			var ev anthropicContentBlockDelta
			if err := json.Unmarshal([]byte(data), &ev); err == nil {
				switch ev.Delta.Type {
				case "text_delta":
					chunk := StreamChunk{
						ID:    msgID,
						Model: msgModel,
						Choices: []StreamChoice{
							{
								Delta: StreamDelta{
									Content: ev.Delta.Text,
								},
							},
						},
					}
					chunksReceived++
					if err := callback(chunk); err != nil {
						return err
					}

				case "input_json_delta":
					if tb, ok := activeTools[ev.Index]; ok {
						tb.args.WriteString(ev.Delta.PartialJSON)
						// Emit incremental tool call argument chunk
						chunk := StreamChunk{
							ID:    msgID,
							Model: msgModel,
							Choices: []StreamChoice{
								{
									Delta: StreamDelta{
										ToolCalls: []StreamToolCallDelta{
											{
												Index: ev.Index,
												Function: ToolCallFunction{
													Arguments: ev.Delta.PartialJSON,
												},
											},
										},
									},
								},
							},
						}
						chunksReceived++
						if err := callback(chunk); err != nil {
							return err
						}
					}
				}
			}

		case "message_delta":
			var ev anthropicMessageDelta
			if err := json.Unmarshal([]byte(data), &ev); err == nil {
				finishReason := mapStopReason(ev.Delta.StopReason)
				chunk := StreamChunk{
					ID:    msgID,
					Model: msgModel,
					Choices: []StreamChoice{
						{
							FinishReason: &finishReason,
						},
					},
				}
				if ev.Usage != nil {
					chunk.Usage = &CompletionUsage{
						PromptTokens:     ev.Usage.InputTokens,
						CompletionTokens: ev.Usage.OutputTokens,
					}
				}
				chunksReceived++
				if err := callback(chunk); err != nil {
					return err
				}
			}

		case "error":
			var errResp anthropicErrorResponse
			if json.Unmarshal([]byte(data), &errResp) == nil && errResp.Error.Message != "" {
				return fmt.Errorf("anthropic stream error: %s (type=%s)", errResp.Error.Message, errResp.Error.Type)
			}
			return fmt.Errorf("anthropic stream error: %s", data)

		case "message_stop":
			// Stream complete
			return nil
		}

		currentEventType = ""
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("stream read error after %d chunks: %w", chunksReceived, err)
	}

	if chunksReceived == 0 {
		return fmt.Errorf("stream ended without data (no chunks received)")
	}

	return nil
}
