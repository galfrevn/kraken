import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bold, colorize, fail, success, warn, KRAKEN_HOME } from "@/constants.ts";
import { API_KEY_ENV_VAR_BY_PROVIDER } from "@/providers.ts";

function findConfigFile(): string | null {
  const globalConfig = join(KRAKEN_HOME, "kraken.yml");
  if (existsSync(globalConfig)) return globalConfig;
  return null;
}

function printConfig(filePath: string): void {
  console.log(`\n  ${colorize("config:", "dim")} ${filePath}\n`);

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    if (line.startsWith("#")) {
      console.log(`  ${colorize(line, "dim")}`);
    } else if (line.includes(":") && !line.startsWith(" ")) {
      const [key, ...rest] = line.split(":");
      console.log(`  ${colorize(key!, "cyan")}:${rest.join(":")}`);
    } else {
      console.log(`  ${line}`);
    }
  }
}

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const keys = keyPath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

function parseYamlSimple(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]!.obj;
    const colonIndex = trimmed.indexOf(":");

    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    if (!rawValue) {
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      stack.push({ indent, obj: nested });
    } else {
      parent[key] = rawValue;
    }
  }

  return result;
}

function rewriteYamlValue(content: string, keyPath: string, newValue: string): string {
  const keys = keyPath.split(".");
  const lastKey = keys[keys.length - 1]!;

  const lines = content.split("\n");
  const targetIndent = (keys.length - 1) * 2;
  let inCorrectParent = keys.length === 1;
  let parentDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (!inCorrectParent && parentDepth < keys.length - 1) {
      const expectedParent = keys[parentDepth]!;
      if (trimmed.startsWith(`${expectedParent}:`) && indent === parentDepth * 2) {
        parentDepth++;
        if (parentDepth === keys.length - 1) {
          inCorrectParent = true;
        }
      }
    } else if (inCorrectParent && trimmed.startsWith(`${lastKey}:`) && indent === targetIndent) {
      lines[i] = `${" ".repeat(targetIndent)}${lastKey}: ${newValue}`;
      return lines.join("\n");
    }
  }

  return content;
}

function validateCronExpression(cronExpression: string): boolean {
  const cronFields = cronExpression.trim().split(/\s+/);
  return cronFields.length === 5;
}

function validateConfiguration(configurationFilePath: string): void {
  const fileContents = readFileSync(configurationFilePath, "utf-8");
  const parsedConfiguration = parseYamlSimple(fileContents);

  let validationErrorCount = 0;
  let validationWarningCount = 0;

  console.log(`\n  ${bold("Configuration Validation")} ${colorize(`(${configurationFilePath})`, "dim")}\n`);

  if (!parsedConfiguration.repo) {
    fail("missing required field: repo");
    validationErrorCount++;
  } else {
    success("repo is set");
  }

  const languageModelSection = parsedConfiguration.languageModel as Record<string, string> | undefined;

  if (!languageModelSection?.provider) {
    fail("missing required field: languageModel.provider");
    validationErrorCount++;
  } else {
    success(`languageModel.provider: ${languageModelSection.provider}`);
  }

  if (!languageModelSection?.model) {
    fail("missing required field: languageModel.model");
    validationErrorCount++;
  } else {
    success(`languageModel.model: ${languageModelSection.model}`);
  }

  if (languageModelSection?.provider) {
    const expectedEnvironmentVariable = API_KEY_ENV_VAR_BY_PROVIDER[languageModelSection.provider];
    if (expectedEnvironmentVariable) {
      const apiKeyValue = Bun.env[expectedEnvironmentVariable];
      if (apiKeyValue) {
        success(`${expectedEnvironmentVariable} is set in environment`);
      } else {
        const envFilePath = join(KRAKEN_HOME, ".env");
        if (existsSync(envFilePath)) {
          const envFileContents = readFileSync(envFilePath, "utf-8");
          const envFileHasKey = envFileContents.includes(`${expectedEnvironmentVariable}=`);
          if (envFileHasKey) {
            success(`${expectedEnvironmentVariable} found in ~/.kraken/.env`);
          } else {
            fail(`${expectedEnvironmentVariable} not found (required for ${languageModelSection.provider})`);
            validationErrorCount++;
          }
        } else {
          fail(`${expectedEnvironmentVariable} not found and ~/.kraken/.env does not exist`);
          validationErrorCount++;
        }
      }
    }
  }

  const triggersSection = parsedConfiguration.triggers as Record<string, unknown> | undefined;

  if (triggersSection) {
    const cronsSubsection = triggersSection.crons;
    if (typeof cronsSubsection === "object" && cronsSubsection !== null) {
      const cronLines = fileContents.split("\n");
      let insideCronsSection = false;

      for (const currentLine of cronLines) {
        const trimmedLine = currentLine.trim();
        if (trimmedLine === "crons:" && currentLine.startsWith("  ")) {
          insideCronsSection = true;
          continue;
        }

        if (insideCronsSection) {
          const lineIndentation = currentLine.length - currentLine.trimStart().length;
          if (lineIndentation <= 2 && trimmedLine && !trimmedLine.startsWith("#")) {
            insideCronsSection = false;
            continue;
          }

          if (trimmedLine.startsWith("expression:")) {
            const cronExpressionValue = trimmedLine.slice("expression:".length).trim().replace(/^["']|["']$/g, "");
            if (cronExpressionValue && !validateCronExpression(cronExpressionValue)) {
              warn(`cron expression "${cronExpressionValue}" does not have 5 fields`);
              validationWarningCount++;
            } else if (cronExpressionValue) {
              success(`cron expression valid: ${cronExpressionValue}`);
            }
          }
        }
      }
    }
  }

  const notificationsSection = parsedConfiguration.notifications as Record<string, unknown> | undefined;

  if (notificationsSection) {
    const notificationLines = fileContents.split("\n");
    for (const currentLine of notificationLines) {
      const trimmedLine = currentLine.trim();

      if (trimmedLine.startsWith("url:")) {
        const webhookUrlValue = trimmedLine.slice("url:".length).trim().replace(/^["']|["']$/g, "");
        if (webhookUrlValue && !webhookUrlValue.startsWith("${") && !webhookUrlValue.startsWith("https://")) {
          warn(`notification URL should start with https:// (found: ${webhookUrlValue.slice(0, 30)}...)`);
          validationWarningCount++;
        }
      }

      if (trimmedLine.startsWith("secret:")) {
        const secretValue = trimmedLine.slice("secret:".length).trim().replace(/^["']|["']$/g, "");
        if (secretValue && !secretValue.startsWith("${")) {
          warn(`webhook secret should use env var reference (\${ENV_VAR}) instead of plain string`);
          validationWarningCount++;
        }
      }
    }
  }

  console.log();
  if (validationErrorCount === 0 && validationWarningCount === 0) {
    success("Configuration is valid!");
  } else {
    if (validationErrorCount > 0) {
      fail(`${validationErrorCount} error(s) found`);
    }
    if (validationWarningCount > 0) {
      warn(`${validationWarningCount} warning(s) found`);
    }
  }
  console.log();
}

export async function execute(args: string[]): Promise<void> {
  const configPath = findConfigFile();

  if (!configPath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  if (args.length === 0) {
    printConfig(configPath);
    return;
  }

  const subcommand = args[0];

  if (subcommand === "get" && args[1]) {
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYamlSimple(content);
    const value = getNestedValue(parsed, args[1]);

    if (value === undefined) {
      fail(`key '${args[1]}' not found`);
      process.exit(1);
    }

    if (typeof value === "object") {
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(String(value));
    }
    return;
  }

  if (subcommand === "set" && args[1] && args[2]) {
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYamlSimple(content);
    setNestedValue(parsed, args[1], args[2]);

    const rewritten = rewriteYamlValue(content, args[1], args[2]);
    writeFileSync(configPath, rewritten);
    success(`set ${bold(args[1])} = ${args[2]}`);
    return;
  }

  if (subcommand === "set-key" && args[1]) {
    const envPath = join(KRAKEN_HOME, ".env");
    const newKey = args[1];
    const envVarName = args[2] ?? "OPENROUTER_API_KEY";

    let content = "";
    if (existsSync(envPath)) {
      content = readFileSync(envPath, "utf-8");
    }

    const lines = content.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.startsWith(`${envVarName}=`) || trimmed.startsWith(`# ${envVarName}=`)) {
        lines[i] = `${envVarName}=${newKey}`;
        found = true;
        break;
      }
    }

    if (!found) {
      lines.push(`${envVarName}=${newKey}`);
    }

    writeFileSync(envPath, lines.join("\n"));
    const masked = `${newKey.slice(0, 10)}...${newKey.slice(-4)}`;
    success(`${envVarName} updated (${masked})`);
    warn("restart kraken for changes to take effect");
    return;
  }

  if (subcommand === "path") {
    console.log(configPath);
    return;
  }

  if (subcommand === "validate") {
    validateConfiguration(configPath);
    return;
  }

  console.log(`\n  ${bold("Usage:")}`);
  console.log(
    `    ${colorize("kraken config", "cyan")}                    show full configuration`,
  );
  console.log(
    `    ${colorize("kraken config get", "cyan")} <key>          get a specific value (dot notation)`,
  );
  console.log(
    `    ${colorize("kraken config set", "cyan")} <k> <v>        set a specific value in kraken.yml`,
  );
  console.log(
    `    ${colorize("kraken config set-key", "cyan")} <key>      set the API key in ~/.kraken/.env`,
  );
  console.log(
    `    ${colorize("kraken config path", "cyan")}               show config file path`,
  );
  console.log(
    `    ${colorize("kraken config validate", "cyan")}           validate configuration\n`,
  );
}
