import { z } from "zod";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(): void {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const envFilePath = join(homeDirectory, ".kraken", ".env");
  if (!existsSync(envFilePath)) return;

  const envFileContents = readFileSync(envFilePath, "utf-8");
  const envFileLines = envFileContents.split("\n");

  for (const currentLine of envFileLines) {
    const trimmedLine = currentLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const equalsPosition = trimmedLine.indexOf("=");
    if (equalsPosition === -1) continue;

    const environmentVariableName = trimmedLine.slice(0, equalsPosition).trim();
    const environmentVariableValue = trimmedLine.slice(equalsPosition + 1).trim();

    if (environmentVariableName && !process.env[environmentVariableName]) {
      process.env[environmentVariableName] = environmentVariableValue;
    }
  }
}

loadEnvFile();

const agentConfigSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().optional(),
  disabled: z.boolean().optional(),
  maxSteps: z.number().optional(),
});

const configSchema = z.object({
  provider: z.string().default("openrouter"),
  model: z.string().default("moonshotai/kimi-k2.5"),
  smallModel: z.string().default("anthropic/claude-3.5-haiku"),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(1).default(0),
  maxTokens: z.number().default(16384),
  daemonUrl: z.string().default("http://localhost:50051"),
  embeddingModel: z.string().default("openai/text-embedding-3-small"),
  agents: z.record(z.string(), agentConfigSchema).default({}),
});

export type KrakenConfig = z.infer<typeof configSchema>;

let cachedConfig: KrakenConfig | null = null;

const resetCallbacks: Array<() => void> = [];

export function onConfigReset(callback: () => void): void {
  resetCallbacks.push(callback);
}

export function resetConfig(): void {
  cachedConfig = null;
  for (const callback of resetCallbacks) callback();
}

export function stripJsoncComments(input: string): string {
  const inputLength = input.length;
  let output = "";
  let cursor = 0;
  while (cursor < inputLength) {
    if (input[cursor] === '"') {
      output += '"';
      cursor++;
      while (cursor < inputLength && input[cursor] !== '"') {
        if (input[cursor] === "\\" && cursor + 1 < inputLength) {
          output += input.charAt(cursor) + input.charAt(cursor + 1);
          cursor += 2;
        } else {
          output += input[cursor];
          cursor++;
        }
      }
      if (cursor < inputLength) {
        output += '"';
        cursor++;
      }
    } else if (cursor + 1 < inputLength && input[cursor] === "/" && input[cursor + 1] === "/") {
      cursor += 2;
      while (cursor < inputLength && input[cursor] !== "\n") cursor++;
    } else if (cursor + 1 < inputLength && input[cursor] === "/" && input[cursor + 1] === "*") {
      cursor += 2;
      while (cursor + 1 < inputLength && !(input[cursor] === "*" && input[cursor + 1] === "/"))
        cursor++;
      if (cursor + 1 < inputLength) cursor += 2;
    } else {
      output += input[cursor];
      cursor++;
    }
  }
  return output;
}

export function loadConfig(): KrakenConfig {
  if (cachedConfig) return cachedConfig;

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";

  let rawConfigData: Record<string, unknown> = {};

  const krakenJsoncPath =
    process.env.KRAKEN_CONFIGURATION_FILE ?? join(homeDirectory, ".kraken", "kraken.jsonc");

  if (existsSync(krakenJsoncPath)) {
    try {
      const fileContents = readFileSync(krakenJsoncPath, "utf-8");
      const parsed = JSON.parse(stripJsoncComments(fileContents));
      if (parsed.languageModel) {
        if (parsed.languageModel.provider) rawConfigData.provider = parsed.languageModel.provider;
        if (parsed.languageModel.model) rawConfigData.model = parsed.languageModel.model;
        if (parsed.languageModel.temperature != null)
          rawConfigData.temperature = parsed.languageModel.temperature;
        if (parsed.languageModel.maxTokens != null)
          rawConfigData.maxTokens = parsed.languageModel.maxTokens;
      }
      if (parsed.services?.daemonPort)
        rawConfigData.daemonUrl = `http://localhost:${parsed.services.daemonPort}`;
      if (parsed.embedding?.model) rawConfigData.embeddingModel = parsed.embedding.model;
      if (parsed.languageModel?.smallModel)
        rawConfigData.smallModel = parsed.languageModel.smallModel;
      if (parsed.agents) rawConfigData.agents = parsed.agents;
    } catch {
      console.warn(`[config] failed to parse ${krakenJsoncPath}, using defaults`);
    }
  }

  const environmentOverrides: Record<string, unknown> = {};
  const apiKey =
    process.env.KRAKEN_OPENROUTER_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.OPENAI_API_KEY;
  if (apiKey) environmentOverrides.apiKey = apiKey;
  if (process.env.KRAKEN_MODEL) environmentOverrides.model = process.env.KRAKEN_MODEL;
  if (process.env.KRAKEN_PROVIDER) environmentOverrides.provider = process.env.KRAKEN_PROVIDER;
  if (process.env.KRAKEN_DAEMON_URL) environmentOverrides.daemonUrl = process.env.KRAKEN_DAEMON_URL;

  if (!environmentOverrides.model || !environmentOverrides.provider) {
    const modelStatePath = join(homeDirectory, ".kraken", "cache", "modelstate.json");
    if (existsSync(modelStatePath)) {
      try {
        const modelStateData = JSON.parse(readFileSync(modelStatePath, "utf-8"));
        if (modelStateData?.current) {
          if (!environmentOverrides.model && modelStateData.current.modelId) {
            rawConfigData.model = modelStateData.current.modelId;
          }
          if (!environmentOverrides.provider && modelStateData.current.providerId) {
            rawConfigData.provider = modelStateData.current.providerId;
          }
        }
      } catch {}
    }
  }

  cachedConfig = configSchema.parse({ ...rawConfigData, ...environmentOverrides });
  return cachedConfig;
}
