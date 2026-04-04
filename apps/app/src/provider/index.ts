import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModelV1 } from "ai";
import { loadConfig, onConfigReset } from "@/config/index.ts";
import type { AgentModel } from "@/agent/agent.ts";

interface ProviderDefinition {
  name: string;
  createModel(modelId: string, apiKey?: string): LanguageModelV1;
}

const providerDefinitions: Record<string, ProviderDefinition> = {
  openrouter: {
    name: "OpenRouter",
    createModel(modelId: string, apiKey?: string) {
      const openrouterClient = createOpenRouter({
        apiKey: apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
      });
      return openrouterClient.chat(modelId);
    },
  },
  anthropic: {
    name: "Anthropic",
    createModel(modelId: string, apiKey?: string) {
      const anthropicClient = createAnthropic({
        apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
      });
      return anthropicClient(modelId);
    },
  },
  openai: {
    name: "OpenAI",
    createModel(modelId: string, apiKey?: string) {
      const openaiClient = createOpenAI({
        apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? "",
      });
      return openaiClient(modelId);
    },
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
  const providerDefinition = providerDefinitions[provider];
  if (!providerDefinition) {
    throw new Error(
      `Unknown provider: ${provider}. Available: ${Object.keys(providerDefinitions).join(", ")}`,
    );
  }

  const model = providerDefinition.createModel(modelId, config.apiKey);
  modelCache.set(cacheKey, model);
  return model;
}

export function resolveLanguageModel(agentModel?: AgentModel): LanguageModelV1 {
  if (agentModel) {
    return createModelFromSpec(agentModel.provider, agentModel.model);
  }
  const config = loadConfig();
  return createModelFromSpec(config.provider, config.model);
}

export function resolveSmallModel(): LanguageModelV1 {
  const config = loadConfig();
  const smallModelString = config.smallModel;
  const slashIndex = smallModelString.indexOf("/");
  if (slashIndex === -1) {
    return createModelFromSpec(config.provider, smallModelString);
  }
  return createModelFromSpec(
    smallModelString.slice(0, slashIndex),
    smallModelString.slice(slashIndex + 1),
  );
}

export function invalidateModelCache(): void {
  modelCache.clear();
}
