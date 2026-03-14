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

const defaultModel = "deepseek/deepseek-v3.2"

type ToolFunction struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters"`
}

type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolCallEntry struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ToolCallFunction `json:"function"`
}

type ChatMessage struct {
	Role       string          `json:"role"`
	Content    string          `json:"content,omitempty"`
	ToolCalls  []ToolCallEntry `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	Name       string          `json:"name,omitempty"`
}

type CompletionRequest struct {
	Model            string        `json:"model"`
	Messages         []ChatMessage `json:"messages"`
	Temperature      *float32      `json:"temperature,omitempty"`
	MaxTokens        *int32        `json:"max_tokens,omitempty"`
	Stream           bool          `json:"stream"`
	Tools            []Tool        `json:"tools,omitempty"`
	IncludeReasoning bool          `json:"include_reasoning"`
	Provider         string        `json:"-"` // routing hint, not sent to API
}

type CompletionChoice struct {
	Message      ChatMessage `json:"message"`
	FinishReason string      `json:"finish_reason"`
}

type CompletionUsage struct {
	PromptTokens     int32 `json:"prompt_tokens"`
	CompletionTokens int32 `json:"completion_tokens"`
}

type CompletionError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    any    `json:"code"`
}

type CompletionResponse struct {
	ID      string             `json:"id"`
	Model   string             `json:"model"`
	Choices []CompletionChoice `json:"choices"`
	Usage   CompletionUsage    `json:"usage"`
	Error   *CompletionError   `json:"error,omitempty"`
}

type OpenAICompatibleClient struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	provider   string // "openrouter", "openai", "ollama"
}

func NewOpenAICompatibleClient(provider, apiKey, baseURL string) *OpenAICompatibleClient {
	if baseURL == "" {
		switch provider {
		case "openai":
			baseURL = "https://api.openai.com/v1"
		case "ollama":
			baseURL = "http://localhost:11434/v1"
		default: // openrouter
			baseURL = "https://openrouter.ai/api/v1"
		}
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

	return &OpenAICompatibleClient{
		apiKey:     apiKey,
		baseURL:    baseURL,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   5 * time.Minute,
		},
		provider: provider,
	}
}

func (c *OpenAICompatibleClient) Complete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	if req.Model == "" {
		req.Model = defaultModel
	}
	req.Stream = false
	if c.provider == "openrouter" {
		req.IncludeReasoning = true
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

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
		return nil, fmt.Errorf("openrouter returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var completionResp CompletionResponse
	if err := json.Unmarshal(respBody, &completionResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w (body: %.500s)", err, string(respBody))
	}

	if completionResp.Error != nil {
		return nil, fmt.Errorf("provider error: %s (type=%s, code=%v)", completionResp.Error.Message, completionResp.Error.Type, completionResp.Error.Code)
	}

	return &completionResp, nil
}

type StreamToolCallDelta struct {
	Index    int              `json:"index"`
	ID       string           `json:"id,omitempty"`
	Type     string           `json:"type,omitempty"`
	Function ToolCallFunction `json:"function"`
}

type StreamDelta struct {
	Content          string                `json:"content"`
	Reasoning        string                `json:"reasoning"`
	ReasoningContent string                `json:"reasoning_content"`
	ToolCalls        []StreamToolCallDelta `json:"tool_calls,omitempty"`
}

// GetReasoning returns whichever reasoning field is populated.
func (d StreamDelta) GetReasoning() string {
	if d.Reasoning != "" {
		return d.Reasoning
	}
	return d.ReasoningContent
}

type StreamChoice struct {
	Delta        StreamDelta `json:"delta"`
	FinishReason *string     `json:"finish_reason"`
}

type StreamChunk struct {
	ID      string           `json:"id"`
	Model   string           `json:"model"`
	Choices []StreamChoice   `json:"choices"`
	Usage   *CompletionUsage `json:"usage,omitempty"`
}

func (c *OpenAICompatibleClient) StreamComplete(ctx context.Context, req CompletionRequest, callback StreamCallback) error {
	if req.Model == "" {
		req.Model = defaultModel
	}
	req.Stream = true
	if c.provider == "openrouter" {
		req.IncludeReasoning = true
	}

	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("openrouter returned status %d: %s", resp.StatusCode, string(respBody))
	}

	scanner := bufio.NewScanner(resp.Body)
	chunksReceived := 0
	receivedDone := false

	for scanner.Scan() {
		line := scanner.Text()

		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			receivedDone = true
			break
		}

		// Check for error responses embedded in stream
		var rawMsg map[string]json.RawMessage
		if err := json.Unmarshal([]byte(data), &rawMsg); err != nil {
			continue
		}
		if errField, ok := rawMsg["error"]; ok {
			var streamErr CompletionError
			if json.Unmarshal(errField, &streamErr) == nil && streamErr.Message != "" {
				return fmt.Errorf("provider stream error: %s (type=%s, code=%v)", streamErr.Message, streamErr.Type, streamErr.Code)
			}
		}

		var chunk StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}

		chunksReceived++

		if err := callback(chunk); err != nil {
			return err
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("stream read error after %d chunks: %w", chunksReceived, err)
	}

	if !receivedDone && chunksReceived == 0 {
		return fmt.Errorf("stream ended without data (no chunks received, no [DONE] marker)")
	}

	return nil
}
