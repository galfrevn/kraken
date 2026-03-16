import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { bold, colorize, fail, success, warn, KRAKEN_HOME } from "@/constants.ts";
import { MODELS_BY_PROVIDER, API_KEY_ENV_VAR_BY_PROVIDER } from "@/providers.ts";

function findConfigurationFilePath(): string | null {
  const globalConfigPath = join(KRAKEN_HOME, "kraken.yml");
  if (existsSync(globalConfigPath)) return globalConfigPath;
  return null;
}

function readApiKeysFromEnvFile(): Record<string, string> {
  const environmentFilePath = join(KRAKEN_HOME, ".env");
  const parsedKeyValuePairs: Record<string, string> = {};
  if (!existsSync(environmentFilePath)) return parsedKeyValuePairs;
  const environmentFileContents = readFileSync(environmentFilePath, "utf-8");
  for (const currentLine of environmentFileContents.split("\n")) {
    const trimmedLine = currentLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    const equalsPosition = trimmedLine.indexOf("=");
    if (equalsPosition > 0) {
      const variableName = trimmedLine.slice(0, equalsPosition).trim();
      const variableValue = trimmedLine.slice(equalsPosition + 1).trim();
      if (variableValue) parsedKeyValuePairs[variableName] = variableValue;
    }
  }
  return parsedKeyValuePairs;
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

  const currentModel = languageModelSection?.model ?? "not set";

  console.log(`\n  ${bold("LLM Provider Configuration")}\n`);
  console.log(`    ${bold("Provider:")}  ${colorize("OpenRouter", "cyan")}`);
  console.log(`    ${bold("Model:")}     ${currentModel}`);

  console.log(`\n  ${bold("API Key:")}\n`);

  const apiKeysFromEnvFile = readApiKeysFromEnvFile();
  const openrouterApiKeyValue = Bun.env["OPENROUTER_API_KEY"] || apiKeysFromEnvFile["OPENROUTER_API_KEY"];
  const openrouterKeyStatusIndicator = openrouterApiKeyValue
    ? colorize("set", "green")
    : colorize("not set", "red");

  console.log(`    ${"OPENROUTER_API_KEY".padEnd(24)} ${openrouterKeyStatusIndicator}`);
  console.log();
}

async function switchModelInteractively(): Promise<void> {
  const configurationFilePath = findConfigurationFilePath();

  if (!configurationFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  p.intro("Switch model");

  const availableOpenRouterModels = MODELS_BY_PROVIDER["openrouter"];
  if (!availableOpenRouterModels) {
    fail("no models available for OpenRouter");
    process.exit(1);
  }

  const selectedModel = await p.select({
    message: "Select model",
    options: availableOpenRouterModels,
  });

  if (p.isCancel(selectedModel)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const openrouterEnvironmentVariableName = API_KEY_ENV_VAR_BY_PROVIDER["openrouter"]!;
  const apiKeysFromEnvFile = readApiKeysFromEnvFile();
  const existingApiKeyValue = Bun.env[openrouterEnvironmentVariableName] || apiKeysFromEnvFile[openrouterEnvironmentVariableName];
  let finalApiKeyValue = "";

  if (existingApiKeyValue) {
    const maskedExistingKey = `${existingApiKeyValue.slice(0, 10)}...${existingApiKeyValue.slice(-4)}`;
    const shouldUseExistingKey = await p.confirm({
      message: `Found ${openrouterEnvironmentVariableName} (${maskedExistingKey}). Use it?`,
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
      message: "Enter your OpenRouter API key",
      placeholder: "sk-or-...",
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
  updatedFileContents = rewriteYamlValue(updatedFileContents, "languageModel.provider", "openrouter");
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
    if (trimmedEnvironmentLine.startsWith(`${openrouterEnvironmentVariableName}=`) || trimmedEnvironmentLine.startsWith(`# ${openrouterEnvironmentVariableName}=`)) {
      environmentFileLines[lineIndex] = `${openrouterEnvironmentVariableName}=${finalApiKeyValue}`;
      apiKeyLineFound = true;
      break;
    }
  }

  if (!apiKeyLineFound) {
    environmentFileLines.push(`${openrouterEnvironmentVariableName}=${finalApiKeyValue}`);
  }

  writeFileSync(environmentFilePath, environmentFileLines.join("\n"));

  success(`Model: ${selectedModel}`);
  success(`API key saved to ~/.kraken/.env`);

  warn("Restart kraken for changes to take effect.");
  p.outro("Model switched successfully.");
}

function setApiKeyDirectly(apiKeyValue: string): void {
  const openrouterEnvironmentVariableName = API_KEY_ENV_VAR_BY_PROVIDER["openrouter"]!;
  const environmentFilePath = join(KRAKEN_HOME, ".env");

  let environmentFileContents = "";
  if (existsSync(environmentFilePath)) {
    environmentFileContents = readFileSync(environmentFilePath, "utf-8");
  }

  const environmentFileLines = environmentFileContents.split("\n");
  let existingLineFound = false;

  for (let lineIndex = 0; lineIndex < environmentFileLines.length; lineIndex++) {
    const trimmedLine = environmentFileLines[lineIndex]!.trim();
    if (trimmedLine.startsWith(`${openrouterEnvironmentVariableName}=`) || trimmedLine.startsWith(`# ${openrouterEnvironmentVariableName}=`)) {
      environmentFileLines[lineIndex] = `${openrouterEnvironmentVariableName}=${apiKeyValue}`;
      existingLineFound = true;
      break;
    }
  }

  if (!existingLineFound) {
    environmentFileLines.push(`${openrouterEnvironmentVariableName}=${apiKeyValue}`);
  }

  writeFileSync(environmentFilePath, environmentFileLines.join("\n"));

  const maskedApiKey = `${apiKeyValue.slice(0, 10)}...${apiKeyValue.slice(-4)}`;
  success(`${openrouterEnvironmentVariableName} updated (${maskedApiKey})`);
  warn("Restart kraken for changes to take effect.");
}

function printProviderUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken provider", "cyan")} ${colorize("<subcommand>", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("list", "cyan")}              Show current model and API key status`);
  console.log(`    ${colorize("switch", "cyan")}            Interactive wizard to change model`);
  console.log(`    ${colorize("set-key", "cyan")} ${colorize("<key>", "dim")}      Set OpenRouter API key\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((argument) => !argument.startsWith("-"));

  switch (subcommand) {
    case "list":
      listProviderConfiguration();
      break;
    case "switch":
      await switchModelInteractively();
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
