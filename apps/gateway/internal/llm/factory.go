package llm

import (
	"fmt"
	"os"
)

// NewClientFromEnv creates the appropriate LLM client based on environment variables.
func NewClientFromEnv() (LLMClient, error) {
	provider := getEnvOrDefault("LLM_PROVIDER", "openrouter")

	switch provider {
	case "openrouter":
		apiKey := getEnvOrDefault("OPENROUTER_API_KEY", getEnvOrDefault("KRAKEN_OPENROUTER_API_KEY", ""))
		baseURL := getEnvOrDefault("OPENROUTER_BASE_URL", "")
		return NewOpenAICompatibleClient("openrouter", apiKey, baseURL), nil

	case "openai":
		apiKey := getEnvOrDefault("OPENAI_API_KEY", "")
		baseURL := getEnvOrDefault("OPENAI_BASE_URL", "")
		return NewOpenAICompatibleClient("openai", apiKey, baseURL), nil

	case "anthropic":
		apiKey := getEnvOrDefault("ANTHROPIC_API_KEY", "")
		baseURL := getEnvOrDefault("ANTHROPIC_BASE_URL", "")
		return NewAnthropicClient(apiKey, baseURL), nil

	case "ollama":
		baseURL := getEnvOrDefault("OLLAMA_BASE_URL", "")
		return NewOpenAICompatibleClient("ollama", "", baseURL), nil

	default:
		return nil, fmt.Errorf("unknown LLM provider: %s (supported: openrouter, openai, anthropic, ollama)", provider)
	}
}

func getEnvOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
