import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { agentConfigurationSchema, type AgentConfiguration } from "@/configuration/schema.ts";

const ENVIRONMENT_VARIABLE = {
  configurationFile: "KRAKEN_CONFIGURATION_FILE",
  schedulerUrl: "KRAKEN_SCHEDULER_URL",
  gatewayUrl: "KRAKEN_GATEWAY_URL",
  openrouterApiKey: "KRAKEN_OPENROUTER_API_KEY",
} as const;

const DEFAULT_CONFIGURATION_FILE_NAME = "kraken.yml";
const ALTERNATIVE_CONFIGURATION_FILE_NAME = "kraken.yaml";
const GLOBAL_KRAKEN_HOME = resolve(homedir(), ".kraken");

async function findConfigurationFile(): Promise<string | undefined> {
  const overridePath = Bun.env[ENVIRONMENT_VARIABLE.configurationFile];
  if (overridePath) {
    if (await Bun.file(overridePath).exists()) {
      return overridePath;
    }
    throw new Error(
      `configuration file not found at ${ENVIRONMENT_VARIABLE.configurationFile}="${overridePath}"`,
    );
  }

  const globalPrimary = join(GLOBAL_KRAKEN_HOME, DEFAULT_CONFIGURATION_FILE_NAME);
  if (await Bun.file(globalPrimary).exists()) {
    return globalPrimary;
  }

  const globalAlternative = join(GLOBAL_KRAKEN_HOME, ALTERNATIVE_CONFIGURATION_FILE_NAME);
  if (await Bun.file(globalAlternative).exists()) {
    return globalAlternative;
  }

  return undefined;
}

function applyEnvironmentOverrides(
  rawConfiguration: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = { ...rawConfiguration };

  const schedulerUrl = Bun.env[ENVIRONMENT_VARIABLE.schedulerUrl];
  if (schedulerUrl) {
    overrides["services"] = {
      ...(overrides["services"] as Record<string, unknown>),
      schedulerUrl,
    };
  }

  const gatewayUrl = Bun.env[ENVIRONMENT_VARIABLE.gatewayUrl];
  if (gatewayUrl) {
    overrides["services"] = {
      ...(overrides["services"] as Record<string, unknown>),
      gatewayUrl,
    };
  }

  const apiKey = Bun.env[ENVIRONMENT_VARIABLE.openrouterApiKey]
    ?? Bun.env.OPENROUTER_API_KEY
    ?? Bun.env.ANTHROPIC_API_KEY
    ?? Bun.env.OPENAI_API_KEY;
  if (apiKey) {
    overrides["languageModel"] = {
      ...(overrides["languageModel"] as Record<string, unknown>),
      apiKey,
    };
  }

  return overrides;
}

async function loadGlobalEnvFile(): Promise<void> {
  const globalEnvPath = join(GLOBAL_KRAKEN_HOME, ".env");
  if (await Bun.file(globalEnvPath).exists()) {
    const content = await Bun.file(globalEnvPath).text();
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) continue;
      const key = trimmed.slice(0, equalsIndex).trim();
      const value = trimmed.slice(equalsIndex + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

export async function loadConfiguration(_workingDirectory?: string): Promise<AgentConfiguration> {
  await loadGlobalEnvFile();

  const configurationFilePath = await findConfigurationFile();

  let rawConfiguration: Record<string, unknown> = {};

  if (configurationFilePath) {
    const fileContents = await Bun.file(configurationFilePath).text();
    const parsed = parseYaml(fileContents);
    if (parsed && typeof parsed === "object") {
      rawConfiguration = parsed as Record<string, unknown>;
    }
  }

  const withEnvironmentOverrides = applyEnvironmentOverrides(rawConfiguration);
  const validationResult = agentConfigurationSchema.safeParse(withEnvironmentOverrides);

  if (!validationResult.success) {
    const formattedErrors = validationResult.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid configuration:\n${formattedErrors}`);
  }

  return validationResult.data;
}
