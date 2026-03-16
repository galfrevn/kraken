export const LLM_PROVIDERS = [
  { value: "openrouter", label: "OpenRouter", hint: "access to all models" },
];

export const MODELS_BY_PROVIDER: Record<string, { value: string; label: string; hint?: string }[]> = {
  openrouter: [
    { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", hint: "recommended" },
    { value: "moonshotai/kimi-k2.5", label: "Kimi K2.5", hint: "reasoning, fast" },
    { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", hint: "fast, cheap" },
    { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

export const API_KEY_ENV_VAR_BY_PROVIDER: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
};
