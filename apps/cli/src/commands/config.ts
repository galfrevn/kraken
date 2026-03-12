import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bold, colorize, fail, success, warn, KRAKEN_HOME } from "@/constants.ts";

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

  console.log(`\n  ${bold("Usage:")}`);
  console.log(`    ${colorize("kraken config", "cyan")}                    show full configuration`);
  console.log(`    ${colorize("kraken config get", "cyan")} <key>          get a specific value (dot notation)`);
  console.log(`    ${colorize("kraken config set", "cyan")} <k> <v>        set a specific value in kraken.yml`);
  console.log(`    ${colorize("kraken config set-key", "cyan")} <key>      set the API key in ~/.kraken/.env`);
  console.log(`    ${colorize("kraken config path", "cyan")}               show config file path\n`);
}
