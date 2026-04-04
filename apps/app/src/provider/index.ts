import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModelV1 } from "ai";
import { loadConfig, onConfigReset } from "@/config/index.ts";
import type { AgentModel } from "@/agent/agent.ts";
import type { ModelInfo } from "@/models/types.ts";
import { isCopilotConfigured, createCopilotModel, copilotListModels } from "./copilot.ts";

export interface ProviderDefinition {
  id: string;
  name: string;
  createModel(modelId: string, apiKey?: string): LanguageModelV1;
  listModels(): Promise<ModelInfo[]>;
  isConfigured(): boolean;
}

function getOpenRouterApiKey(): string {
  return process.env.KRAKEN_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
}

const providers: Record<string, ProviderDefinition> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    createModel(modelId: string, apiKey?: string) {
      const client = createOpenRouter({ apiKey: apiKey ?? getOpenRouterApiKey() });
      return client.chat(modelId);
    },
    async listModels(): Promise<ModelInfo[]> {
      const apiKey = getOpenRouterApiKey();
      if (!apiKey) return [];
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return [];
        const data = (await response.json()) as {
          data: Array<{
            id: string;
            name: string;
            context_length?: number;
            pricing?: { prompt?: string; completion?: string };
            supported_parameters?: string[];
          }>;
        };
        return data.data
          .filter((m) => m.supported_parameters?.includes("tools"))
          .map((m) => ({
            id: m.id,
            name: m.name,
            providerId: "openrouter",
            providerName: "OpenRouter",
            contextLength: m.context_length,
            cost: m.pricing
              ? {
                  input: parseFloat(m.pricing.prompt ?? "0"),
                  output: parseFloat(m.pricing.completion ?? "0"),
                }
              : undefined,
          }));
      } catch {
        return [];
      }
    },
    isConfigured() {
      return getOpenRouterApiKey().length > 0;
    },
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    createModel(modelId: string) {
      return createCopilotModel(modelId);
    },
    listModels: copilotListModels,
    isConfigured: isCopilotConfigured,
  },
};

const modelCache = new Map<string, LanguageModelV1>();

onConfigReset(() => {
  modelCache.clear();
});

function createModelFromSpec(provider: string, modelId: string): LanguageModelV1 {
  const cacheKey = `${provider}:${modelId}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  const config = loadConfig();
  const providerDef = providers[provider];
  if (!providerDef) {
    throw new Error(
      `Unknown provider: ${provider}. Available: ${Object.keys(providers).join(", ")}`,
    );
  }

  const model = providerDef.createModel(modelId, config.apiKey);
  modelCache.set(cacheKey, model);
  return model;
}

export function resolveLanguageModel(agentModel?: AgentModel): LanguageModelV1 {
  if (agentModel) {
    return createModelFromSpec(agentModel.provider, agentModel.model);
  }
  const config = loadConfig();
  if (!config.provider || !config.model) {
    throw new Error("Provider and model must be configured.");
  }
  return createModelFromSpec(config.provider, config.model);
}

export function resolveSmallModel(): LanguageModelV1 {
  const config = loadConfig();
  if (!config.provider) {
    throw new Error("Provider must be configured.");
  }
  const smallModelString = config.smallModel;
  if (!smallModelString) {
    return createModelFromSpec(config.provider, config.model ?? "");
  }
  const slashIndex = smallModelString.indexOf("/");
  if (slashIndex === -1) {
    return createModelFromSpec(config.provider, smallModelString);
  }
  return createModelFromSpec(
    smallModelString.slice(0, slashIndex),
    smallModelString.slice(slashIndex + 1),
  );
}

export function getConfiguredProviders(): ProviderDefinition[] {
  return Object.values(providers).filter((p) => p.isConfigured());
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return providers[id];
}

export function invalidateModelCache(): void {
  modelCache.clear();
}
