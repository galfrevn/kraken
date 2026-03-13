package llm

import "context"

// LLMClient defines the interface for LLM provider clients.
type LLMClient interface {
	Complete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error)
	StreamComplete(ctx context.Context, req CompletionRequest, callback StreamCallback) error
}

// StreamCallback is a function that receives streaming chunks from the LLM provider.
type StreamCallback func(chunk StreamChunk) error
