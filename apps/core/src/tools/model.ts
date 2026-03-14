import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Tool, ToolResult } from "@/tools/schema.ts";
import type { LanguageModelClient } from "@/language/client.ts";

const KRAKEN_HOME = resolve(homedir(), ".kraken");
const CONFIGURATION_FILE_NAME = "kraken.yml";
const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

interface OpenRouterModelPricing {
  prompt: string;
  completion: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: OpenRouterModelPricing;
  top_provider?: { max_completion_tokens?: number };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

function getGlobalConfigPath(): string {
  return join(KRAKEN_HOME, CONFIGURATION_FILE_NAME);
}

export async function persistModelToConfiguration(newModel: string): Promise<string> {
  const configurationPath = getGlobalConfigPath();

  if (!(await Bun.file(configurationPath).exists())) {
    const minimal = { languageModel: { model: newModel } };
    await Bun.write(configurationPath, stringifyYaml(minimal));
    return configurationPath;
  }

  const fileContents = await Bun.file(configurationPath).text();
  const parsed = parseYaml(fileContents) ?? {};

  if (!parsed.languageModel || typeof parsed.languageModel !== "object") {
    parsed.languageModel = {};
  }
  parsed.languageModel.model = newModel;

  await Bun.write(configurationPath, stringifyYaml(parsed));
  return configurationPath;
}

export async function persistProviderAndModel(provider: string, newModel: string): Promise<string> {
  const configurationPath = getGlobalConfigPath();

  if (!(await Bun.file(configurationPath).exists())) {
    const minimal = { languageModel: { provider, model: newModel } };
    await Bun.write(configurationPath, stringifyYaml(minimal));
    return configurationPath;
  }

  const fileContents = await Bun.file(configurationPath).text();
  const parsed = parseYaml(fileContents) ?? {};

  if (!parsed.languageModel || typeof parsed.languageModel !== "object") {
    parsed.languageModel = {};
  }
  parsed.languageModel.provider = provider;
  parsed.languageModel.model = newModel;

  await Bun.write(configurationPath, stringifyYaml(parsed));
  return configurationPath;
}

function resolveOpenRouterApiKey(): string | undefined {
  return Bun.env["OPENROUTER_API_KEY"] ?? Bun.env["KRAKEN_OPENROUTER_API_KEY"] ?? undefined;
}

function formatTokenPrice(pricePerToken: string): string {
  const perMillion = parseFloat(pricePerToken) * 1_000_000;
  if (perMillion === 0) return "free";
  return `$${perMillion.toFixed(2)}/M`;
}

function formatContextLength(contextLength: number): string {
  if (contextLength >= 1_000_000) return `${(contextLength / 1_000_000).toFixed(1)}M`;
  if (contextLength >= 1_000) return `${Math.round(contextLength / 1_000)}k`;
  return String(contextLength);
}

async function fetchOpenRouterModels(query?: string): Promise<string> {
  const apiKey = resolveOpenRouterApiKey();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(OPENROUTER_MODELS_ENDPOINT, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter returned ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  let models = payload.data;

  if (query) {
    const normalizedQuery = query.toLowerCase();
    models = models.filter(
      (model) =>
        model.id.toLowerCase().includes(normalizedQuery) ||
        model.name.toLowerCase().includes(normalizedQuery),
    );
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) {
    return query ? `no models found matching "${query}"` : "no models available";
  }

  const lines = models.slice(0, 50).map((model) => {
    const inputPrice = formatTokenPrice(model.pricing.prompt);
    const outputPrice = formatTokenPrice(model.pricing.completion);
    const context = formatContextLength(model.context_length);
    return `${model.id}  (${context} ctx, in: ${inputPrice}, out: ${outputPrice})`;
  });

  const header = query
    ? `${models.length} models matching "${query}"${models.length > 50 ? " (showing first 50)" : ""}:`
    : `${models.length} models available${models.length > 50 ? " (showing first 50)" : ""}:`;

  return header + "\n" + lines.join("\n");
}

let cachedModelIds: string[] | null = null;
let cacheTimestamp = 0;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function fetchOpenRouterModelIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedModelIds && now - cacheTimestamp < MODEL_CACHE_TTL_MS) {
    return cachedModelIds;
  }

  const apiKey = resolveOpenRouterApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(OPENROUTER_MODELS_ENDPOINT, { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter returned ${response.status}`);
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  cachedModelIds = payload.data.map((m) => m.id).sort();
  cacheTimestamp = now;
  return cachedModelIds;
}

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

const OPENAI_CHAT_PREFIXES = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];

interface OpenAIModel {
  id: string;
  object: string;
  owned_by: string;
}

interface OpenAIModelsResponse {
  data: OpenAIModel[];
}

let cachedOpenAIModelIds: string[] | null = null;
let openAICacheTimestamp = 0;

export async function fetchOpenAIModelIds(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (cachedOpenAIModelIds && now - openAICacheTimestamp < MODEL_CACHE_TTL_MS) {
    return cachedOpenAIModelIds;
  }

  const response = await fetch(OPENAI_MODELS_ENDPOINT, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}`);
  }

  const payload = (await response.json()) as OpenAIModelsResponse;
  cachedOpenAIModelIds = payload.data
    .filter((m) => OPENAI_CHAT_PREFIXES.some((p) => m.id.startsWith(p)))
    .map((m) => m.id)
    .sort();
  openAICacheTimestamp = now;
  return cachedOpenAIModelIds;
}

const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";

interface AnthropicModel {
  id: string;
  display_name: string;
  type: string;
}

interface AnthropicModelsResponse {
  data: AnthropicModel[];
}

let cachedAnthropicModelIds: string[] | null = null;
let anthropicCacheTimestamp = 0;

export async function fetchAnthropicModelIds(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (cachedAnthropicModelIds && now - anthropicCacheTimestamp < MODEL_CACHE_TTL_MS) {
    return cachedAnthropicModelIds;
  }

  const response = await fetch(ANTHROPIC_MODELS_ENDPOINT, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Anthropic returned ${response.status}`);
  }

  const payload = (await response.json()) as AnthropicModelsResponse;
  cachedAnthropicModelIds = payload.data
    .map((m) => m.id)
    .sort();
  anthropicCacheTimestamp = now;
  return cachedAnthropicModelIds;
}

export interface ProviderModel {
  provider: string;
  modelId: string;
}

export async function fetchAllAvailableModels(): Promise<ProviderModel[]> {
  const fetches: Promise<ProviderModel[]>[] = [];

  const openrouterKey = Bun.env["OPENROUTER_API_KEY"] ?? Bun.env["KRAKEN_OPENROUTER_API_KEY"];
  if (openrouterKey) {
    fetches.push(
      fetchOpenRouterModelIds()
        .then((ids) => ids.map((id) => ({ provider: "openrouter", modelId: id })))
    );
  }

  const openaiKey = Bun.env["OPENAI_API_KEY"];
  if (openaiKey) {
    fetches.push(
      fetchOpenAIModelIds(openaiKey)
        .then((ids) => ids.map((id) => ({ provider: "openai", modelId: id })))
    );
  }

  const anthropicKey = Bun.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) {
    fetches.push(
      fetchAnthropicModelIds(anthropicKey)
        .then((ids) => ids.map((id) => ({ provider: "anthropic", modelId: id })))
    );
  }

  const results = await Promise.allSettled(fetches);
  const models: ProviderModel[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      models.push(...result.value);
    }
  }

  return models;
}

export function createModelListTool(): Tool {
  return {
    definition: {
      name: "list_models",
      description: "List available models from OpenRouter.",
      parameters: [
        {
          name: "query",
          type: "string",
          description:
            "Optional search filter to match model ID or name (e.g. 'claude', 'deepseek').",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const query = parameters["query"] as string | undefined;

      try {
        const output = await fetchOpenRouterModels(query || undefined);
        return { success: true, output };
      } catch (fetchError) {
        const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
        return {
          success: false,
          output: "",
          error: `failed to fetch models: ${errorMessage}`,
        };
      }
    },
  };
}

export function createCurrentModelTool(languageModelClient: LanguageModelClient): Tool {
  return {
    definition: {
      name: "current_model",
      description: "Get the current active LLM model. Read-only.",
      parameters: [],
    },

    async execute(): Promise<ToolResult> {
      const runtimeModel = languageModelClient.getModel();

      let configuredModel: string | undefined;
      try {
        const configurationPath = getGlobalConfigPath();
        if (await Bun.file(configurationPath).exists()) {
          const fileContents = await Bun.file(configurationPath).text();
          const parsed = parseYaml(fileContents) ?? {};
          configuredModel = parsed?.languageModel?.model as string | undefined;
        }
      } catch {
        configuredModel = undefined;
      }

      const lines = [`active model: ${runtimeModel}`];

      if (configuredModel && configuredModel !== runtimeModel) {
        lines.push(`configured model (kraken.yml): ${configuredModel}`);
        lines.push("note: runtime model differs from config — the active model is authoritative");
      }

      return { success: true, output: lines.join("\n") };
    },
  };
}

export function createModelSwitchTool(languageModelClient: LanguageModelClient): Tool {
  return {
    definition: {
      name: "switch_model",
      description: "Switch the active LLM model and persist to kraken.yml.",
      parameters: [
        {
          name: "model",
          type: "string",
          description: "The model identifier to switch to (e.g. deepseek/deepseek-v3.2).",
          required: true,
        },
      ],
    },

    async execute(
      parameters: Record<string, unknown>,
    ): Promise<ToolResult> {
      const requestedModel = parameters["model"] as string | undefined;

      if (!requestedModel) {
        return {
          success: false,
          output: "",
          error: "model parameter is required. Use current_model to check the active model.",
        };
      }

      const previousModel = languageModelClient.getModel();
      languageModelClient.setModel(requestedModel);

      try {
        const configurationPath = await persistModelToConfiguration(requestedModel);

        return {
          success: true,
          output:
            `model switched from ${previousModel} to ${requestedModel}\n` +
            `configuration saved to ${configurationPath}`,
        };
      } catch (persistError) {
        const errorMessage =
          persistError instanceof Error ? persistError.message : String(persistError);

        return {
          success: true,
          output:
            `model switched to ${requestedModel} (runtime only)\n` +
            `failed to persist to config: ${errorMessage}`,
        };
      }
    },
  };
}
