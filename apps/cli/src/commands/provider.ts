import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { bold, colorize, fail, success, warn, KRAKEN_HOME } from "@/constants.ts";
import { LLM_PROVIDERS, MODELS_BY_PROVIDER, API_KEY_ENV_VAR_BY_PROVIDER } from "@/providers.ts";

function findConfigurationFilePath(): string | null {
  const globalConfigPath = join(KRAKEN_HOME, "kraken.yml");
  if (existsSync(globalConfigPath)) return globalConfigPath;
  return null;
}

function parseSimpleYaml(fileContents: string): Record<string, unknown> {
  const parsedResult: Record<string, unknown> = {};
  const fileLines = fileContents.split("\n");
  const indentationStack: { indentation: number; container: Record<string, unknown> }[] = [
    { indentation: -1, container: parsedResult },
  ];

  for (const currentLine of fileLines) {
    if (!currentLine.trim() || currentLine.trim().startsWith("#")) continue;

    const currentIndentation = currentLine.length - currentLine.trimStart().length;
    const trimmedLine = currentLine.trim();

    while (indentationStack.length > 1 && indentationStack[indentationStack.length - 1]!.indentation >= currentIndentation) {
      indentationStack.pop();
    }

    const parentContainer = indentationStack[indentationStack.length - 1]!.container;
    const colonPosition = trimmedLine.indexOf(":");
    if (colonPosition === -1) continue;

    const propertyKey = trimmedLine.slice(0, colonPosition).trim();
    const rawPropertyValue = trimmedLine.slice(colonPosition + 1).trim();

    if (!rawPropertyValue) {
      const nestedContainer: Record<string, unknown> = {};
      parentContainer[propertyKey] = nestedContainer;
      indentationStack.push({ indentation: currentIndentation, container: nestedContainer });
    } else {
      parentContainer[propertyKey] = rawPropertyValue.replace(/^["']|["']$/g, "");
    }
  }

  return parsedResult;
}

function rewriteYamlValue(fileContents: string, dotNotationKeyPath: string, newValue: string): string {
  const pathSegments = dotNotationKeyPath.split(".");
  const finalKey = pathSegments[pathSegments.length - 1]!;
  const fileLines = fileContents.split("\n");
  const targetIndentation = (pathSegments.length - 1) * 2;
  let insideCorrectParentSection = pathSegments.length === 1;
  let currentParentDepth = 0;

  for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
    const currentLine = fileLines[lineIndex]!;
    const trimmedLine = currentLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const lineIndentation = currentLine.length - currentLine.trimStart().length;

    if (!insideCorrectParentSection && currentParentDepth < pathSegments.length - 1) {
      const expectedParentKey = pathSegments[currentParentDepth]!;
      if (trimmedLine.startsWith(`${expectedParentKey}:`) && lineIndentation === currentParentDepth * 2) {
        currentParentDepth++;
        if (currentParentDepth === pathSegments.length - 1) {
          insideCorrectParentSection = true;
        }
      }
    } else if (insideCorrectParentSection && trimmedLine.startsWith(`${finalKey}:`) && lineIndentation === targetIndentation) {
      fileLines[lineIndex] = `${" ".repeat(targetIndentation)}${finalKey}: ${newValue}`;
      return fileLines.join("\n");
    }
  }

  return fileContents;
}

function listProviderConfiguration(): void {
  const configurationFilePath = findConfigurationFilePath();

  if (!configurationFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const fileContents = readFileSync(configurationFilePath, "utf-8");
  const parsedConfiguration = parseSimpleYaml(fileContents);
  const languageModelSection = parsedConfiguration.languageModel as Record<string, string> | undefined;

  const currentProvider = languageModelSection?.provider ?? "not set";
  const currentModel = languageModelSection?.model ?? "not set";

  const providerLabel = LLM_PROVIDERS.find((providerOption) => providerOption.value === currentProvider)?.label ?? currentProvider;

  console.log(`\n  ${bold("LLM Provider Configuration")}\n`);
  console.log(`    ${bold("Provider:")}  ${colorize(providerLabel, "cyan")}`);
  console.log(`    ${bold("Model:")}     ${currentModel}`);

  console.log(`\n  ${bold("API Keys:")}\n`);

  for (const [providerName, environmentVariableName] of Object.entries(API_KEY_ENV_VAR_BY_PROVIDER)) {
    const environmentVariableValue = Bun.env[environmentVariableName];
    const providerDisplayLabel = LLM_PROVIDERS.find((providerOption) => providerOption.value === providerName)?.label ?? providerName;
    const isCurrentProvider = providerName === currentProvider;
    const statusIndicator = environmentVariableValue
      ? colorize("set", "green")
      : colorize("not set", "red");
    const currentMarker = isCurrentProvider ? colorize(" (active)", "cyan") : "";

    console.log(`    ${providerDisplayLabel.padEnd(12)} ${environmentVariableName.padEnd(24)} ${statusIndicator}${currentMarker}`);
  }

  console.log();
}

async function switchProviderInteractively(): Promise<void> {
  const configurationFilePath = findConfigurationFilePath();

  if (!configurationFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  p.intro("Switch LLM provider");

  const selectedProvider = await p.select({
    message: "Select LLM provider",
    options: LLM_PROVIDERS,
  });

  if (p.isCancel(selectedProvider)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const availableModelsForProvider = MODELS_BY_PROVIDER[selectedProvider];
  if (!availableModelsForProvider) {
    fail(`No models available for provider "${selectedProvider}"`);
    process.exit(1);
  }

  const selectedModel = await p.select({
    message: "Select model",
    options: availableModelsForProvider,
  });

  if (p.isCancel(selectedModel)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const environmentVariableName = API_KEY_ENV_VAR_BY_PROVIDER[selectedProvider] ?? "OPENROUTER_API_KEY";
  const existingApiKeyValue = Bun.env[environmentVariableName];
  let finalApiKeyValue = "";

  if (existingApiKeyValue) {
    const maskedExistingKey = `${existingApiKeyValue.slice(0, 10)}...${existingApiKeyValue.slice(-4)}`;
    const shouldUseExistingKey = await p.confirm({
      message: `Found ${environmentVariableName} (${maskedExistingKey}). Use it?`,
      initialValue: true,
    });

    if (p.isCancel(shouldUseExistingKey)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (shouldUseExistingKey) {
      finalApiKeyValue = existingApiKeyValue;
    }
  }

  if (!finalApiKeyValue) {
    const enteredApiKey = await p.text({
      message: `Enter your ${selectedProvider} API key`,
      placeholder: "sk-...",
      validate: (inputValue = "") => {
        if (!inputValue.trim()) return "API key is required";
      },
    });

    if (p.isCancel(enteredApiKey)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    finalApiKeyValue = enteredApiKey;
  }

  let updatedFileContents = readFileSync(configurationFilePath, "utf-8");
  updatedFileContents = rewriteYamlValue(updatedFileContents, "languageModel.provider", selectedProvider as string);
  updatedFileContents = rewriteYamlValue(updatedFileContents, "languageModel.model", selectedModel as string);
  writeFileSync(configurationFilePath, updatedFileContents);

  const environmentFilePath = join(KRAKEN_HOME, ".env");
  let environmentFileContents = "";
  if (existsSync(environmentFilePath)) {
    environmentFileContents = readFileSync(environmentFilePath, "utf-8");
  }

  const environmentFileLines = environmentFileContents.split("\n");
  let apiKeyLineFound = false;
  for (let lineIndex = 0; lineIndex < environmentFileLines.length; lineIndex++) {
    const trimmedEnvironmentLine = environmentFileLines[lineIndex]!.trim();
    if (trimmedEnvironmentLine.startsWith(`${environmentVariableName}=`) || trimmedEnvironmentLine.startsWith(`# ${environmentVariableName}=`)) {
      environmentFileLines[lineIndex] = `${environmentVariableName}=${finalApiKeyValue}`;
      apiKeyLineFound = true;
      break;
    }
  }

  if (!apiKeyLineFound) {
    environmentFileLines.push(`${environmentVariableName}=${finalApiKeyValue}`);
  }

  writeFileSync(environmentFilePath, environmentFileLines.join("\n"));

  const providerDisplayLabel = LLM_PROVIDERS.find((providerOption) => providerOption.value === selectedProvider)?.label ?? selectedProvider;
  success(`Provider: ${providerDisplayLabel}`);
  success(`Model: ${selectedModel}`);
  success(`API key saved to ~/.kraken/.env`);

  warn("Restart kraken for changes to take effect.");
  p.outro("Provider switched successfully.");
}

function setApiKeyDirectly(apiKeyValue: string): void {
  const configurationFilePath = findConfigurationFilePath();

  if (!configurationFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const fileContents = readFileSync(configurationFilePath, "utf-8");
  const parsedConfiguration = parseSimpleYaml(fileContents);
  const languageModelSection = parsedConfiguration.languageModel as Record<string, string> | undefined;
  const currentProvider = languageModelSection?.provider ?? "openrouter";

  const environmentVariableName = API_KEY_ENV_VAR_BY_PROVIDER[currentProvider] ?? "OPENROUTER_API_KEY";
  const environmentFilePath = join(KRAKEN_HOME, ".env");

  let environmentFileContents = "";
  if (existsSync(environmentFilePath)) {
    environmentFileContents = readFileSync(environmentFilePath, "utf-8");
  }

  const environmentFileLines = environmentFileContents.split("\n");
  let existingLineFound = false;

  for (let lineIndex = 0; lineIndex < environmentFileLines.length; lineIndex++) {
    const trimmedLine = environmentFileLines[lineIndex]!.trim();
    if (trimmedLine.startsWith(`${environmentVariableName}=`) || trimmedLine.startsWith(`# ${environmentVariableName}=`)) {
      environmentFileLines[lineIndex] = `${environmentVariableName}=${apiKeyValue}`;
      existingLineFound = true;
      break;
    }
  }

  if (!existingLineFound) {
    environmentFileLines.push(`${environmentVariableName}=${apiKeyValue}`);
  }

  writeFileSync(environmentFilePath, environmentFileLines.join("\n"));

  const maskedApiKey = `${apiKeyValue.slice(0, 10)}...${apiKeyValue.slice(-4)}`;
  success(`${environmentVariableName} updated (${maskedApiKey})`);
  warn("Restart kraken for changes to take effect.");
}

function printProviderUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken provider", "cyan")} ${colorize("<subcommand>", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("list", "cyan")}              Show current provider, model, and API key status`);
  console.log(`    ${colorize("switch", "cyan")}            Interactive wizard to change provider, model, and API key`);
  console.log(`    ${colorize("set-key", "cyan")} ${colorize("<key>", "dim")}      Set API key for the current provider\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((argument) => !argument.startsWith("-"));

  switch (subcommand) {
    case "list":
      listProviderConfiguration();
      break;
    case "switch":
      await switchProviderInteractively();
      break;
    case "set-key": {
      const apiKeyArgument = args.find((argument) => argument !== "set-key" && !argument.startsWith("-"));
      if (!apiKeyArgument) {
        fail("missing API key. Usage: kraken provider set-key <key>");
        process.exit(1);
      }
      setApiKeyDirectly(apiKeyArgument);
      break;
    }
    case undefined:
      listProviderConfiguration();
      break;
    default:
      fail(`Unknown provider subcommand: '${subcommand}'`);
      printProviderUsage();
      break;
  }
}
