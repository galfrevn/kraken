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

async function persistModelToConfiguration(newModel: string): Promise<string> {
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

export function createModelListTool(): Tool {
  return {
    definition: {
      name: "list_models",
      description:
        "List available models from OpenRouter. Optionally filter by a search query " +
        "(e.g. 'deepseek', 'claude', 'gpt', 'gemini', 'llama'). " +
        "Returns model IDs, context window size, and pricing.",
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
      description:
        "Returns the model currently being used for inference. " +
        "Also reads the kraken.yml config to show if there is a mismatch. " +
        "Use this tool when the user asks what model you are using. " +
        "This tool is read-only and will never change the model.",
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
      description:
        "Switch the active LLM model and persist the change to kraken.yml. " +
        "ONLY use this when the user explicitly asks to change or switch models. " +
        "To check the current model, use current_model instead. " +
        "Model names follow the OpenRouter format: provider/model-name (e.g. deepseek/deepseek-v3.2, " +
        "anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.5-pro).",
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
