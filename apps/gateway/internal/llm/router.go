package llm

import (
	"context"
	"fmt"
	"os"
)

// ProviderRouter routes LLM requests to the appropriate provider client.
type ProviderRouter struct {
	clients        map[string]LLMClient
	defaultProvider string
}

// NewProviderRouterFromEnv creates a router with clients for all configured providers.
// It reads API keys from environment variables and creates clients for each one found.
// The defaultProvider is used when no provider is specified in a request.
func NewProviderRouterFromEnv() (*ProviderRouter, error) {
	defaultProvider := getEnvOrDefault("LLM_PROVIDER", "openrouter")
	clients := make(map[string]LLMClient)

	// OpenRouter
	openrouterKey := getEnvOrDefault("OPENROUTER_API_KEY", getEnvOrDefault("KRAKEN_OPENROUTER_API_KEY", ""))
	openrouterBaseURL := getEnvOrDefault("OPENROUTER_BASE_URL", "")
	if openrouterKey != "" || defaultProvider == "openrouter" {
		clients["openrouter"] = NewOpenAICompatibleClient("openrouter", openrouterKey, openrouterBaseURL)
	}

	// OpenAI
	openaiKey := getEnvOrDefault("OPENAI_API_KEY", "")
	openaiBaseURL := getEnvOrDefault("OPENAI_BASE_URL", "")
	if openaiKey != "" || defaultProvider == "openai" {
		clients["openai"] = NewOpenAICompatibleClient("openai", openaiKey, openaiBaseURL)
	}

	// Anthropic
	anthropicKey := getEnvOrDefault("ANTHROPIC_API_KEY", "")
	anthropicBaseURL := getEnvOrDefault("ANTHROPIC_BASE_URL", "")
	if anthropicKey != "" || defaultProvider == "anthropic" {
		clients["anthropic"] = NewAnthropicClient(anthropicKey, anthropicBaseURL)
	}

	// Ollama
	ollamaBaseURL := getEnvOrDefault("OLLAMA_BASE_URL", "")
	if ollamaBaseURL != "" || defaultProvider == "ollama" {
		clients["ollama"] = NewOpenAICompatibleClient("ollama", "", ollamaBaseURL)
	}

	if len(clients) == 0 {
		return nil, fmt.Errorf("no LLM providers configured (set OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL)")
	}

	// Ensure the default provider has a client
	if _, ok := clients[defaultProvider]; !ok {
		// Fall back to the first available provider
		for name := range clients {
			defaultProvider = name
			break
		}
	}

	return &ProviderRouter{
		clients:        clients,
		defaultProvider: defaultProvider,
	}, nil
}

func (r *ProviderRouter) resolveClient(provider string) (LLMClient, error) {
	if provider == "" {
		provider = r.defaultProvider
	}

	client, ok := r.clients[provider]
	if !ok {
		// Try to create the client on-the-fly from env (provider may have been configured after startup)
		client = r.tryCreateClient(provider)
		if client == nil {
			return nil, fmt.Errorf("provider %q not configured (available: %v)", provider, r.availableProviders())
		}
		r.clients[provider] = client
	}

	return client, nil
}

func (r *ProviderRouter) tryCreateClient(provider string) LLMClient {
	switch provider {
	case "openrouter":
		key := os.Getenv("OPENROUTER_API_KEY")
		if key == "" {
			key = os.Getenv("KRAKEN_OPENROUTER_API_KEY")
		}
		if key != "" {
			return NewOpenAICompatibleClient("openrouter", key, os.Getenv("OPENROUTER_BASE_URL"))
		}
	case "openai":
		key := os.Getenv("OPENAI_API_KEY")
		if key != "" {
			return NewOpenAICompatibleClient("openai", key, os.Getenv("OPENAI_BASE_URL"))
		}
	case "anthropic":
		key := os.Getenv("ANTHROPIC_API_KEY")
		if key != "" {
			return NewAnthropicClient(key, os.Getenv("ANTHROPIC_BASE_URL"))
		}
	case "ollama":
		baseURL := os.Getenv("OLLAMA_BASE_URL")
		if baseURL != "" {
			return NewOpenAICompatibleClient("ollama", "", baseURL)
		}
	}
	return nil
}

func (r *ProviderRouter) availableProviders() []string {
	providers := make([]string, 0, len(r.clients))
	for name := range r.clients {
		providers = append(providers, name)
	}
	return providers
}

// Complete routes the request to the appropriate provider.
func (r *ProviderRouter) Complete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	client, err := r.resolveClient(req.Provider)
	if err != nil {
		return nil, err
	}
	return client.Complete(ctx, req)
}

// StreamComplete routes the streaming request to the appropriate provider.
func (r *ProviderRouter) StreamComplete(ctx context.Context, req CompletionRequest, callback StreamCallback) error {
	client, err := r.resolveClient(req.Provider)
	if err != nil {
		return err
	}
	return client.StreamComplete(ctx, req, callback)
}
