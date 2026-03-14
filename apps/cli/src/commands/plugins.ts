import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bold,
  colorize,
  fail,
  success,
  warn,
  step,
  KRAKEN_HOME,
  GITHUB_REPO,
} from "@/constants.ts";

const GITHUB_BRANCH = "main";

interface RegistryEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  tools: string[];
  requires: string[];
  directory: string;
}

interface RegistryManifest {
  version: number;
  plugins: RegistryEntry[];
}

function buildRawGitHubUrl(filePath: string): string {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}`;
}

async function fetchRemoteRegistry(): Promise<RegistryManifest> {
  const url = buildRawGitHubUrl("packages/plugins/registry.json");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch plugin registry (${response.status})`);
  }
  return (await response.json()) as RegistryManifest;
}

function checkCommandAvailable(command: string): boolean {
  try {
    const result = Bun.spawnSync({ cmd: ["which", command], stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

interface PluginInfo {
  name: string;
  version: string;
  description: string;
  author?: string;
  path: string;
  toolCount: number;
}

function getPluginsDirectory(): string {
  return join(KRAKEN_HOME, "plugins");
}

function inspectPlugin(pluginPath: string): PluginInfo | null {
  const indexFile = existsSync(join(pluginPath, "index.ts"))
    ? join(pluginPath, "index.ts")
    : existsSync(join(pluginPath, "index.js"))
      ? join(pluginPath, "index.js")
      : null;

  if (!indexFile) return null;

  const content = readFileSync(indexFile, "utf-8");

  const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
  const versionMatch = content.match(/version:\s*["']([^"']+)["']/);
  const descriptionMatch = content.match(/description:\s*["']([^"']+)["']/);
  const authorMatch = content.match(/author:\s*["']([^"']+)["']/);
  const toolCount = content.match(/name:\s*["'][^"']+["']/g)?.length ?? 0;

  return {
    name: nameMatch?.[1] || pluginPath.split("/").pop() || "unknown",
    version: versionMatch?.[1] || "0.0.0",
    description: descriptionMatch?.[1] || "No description",
    author: authorMatch?.[1],
    path: pluginPath,
    toolCount: Math.max(0, toolCount - 1),
  };
}

function listPlugins(pluginsDirectory: string): PluginInfo[] {
  const entries = readdirSync(pluginsDirectory, { withFileTypes: true });
  const plugins: PluginInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginPath = resolve(pluginsDirectory, entry.name);
    const info = inspectPlugin(pluginPath);
    if (info) plugins.push(info);
  }

  return plugins;
}

function printPluginList(plugins: PluginInfo[]): void {
  if (plugins.length === 0) {
    warn("no plugins found");
    console.log(`\n  Create a plugin in ${colorize(".kraken/plugins/", "cyan")} to get started.\n`);
    return;
  }

  console.log();
  for (const plugin of plugins) {
    const authorTag = plugin.author ? ` ${colorize(`by ${plugin.author}`, "dim")}` : "";
    console.log(
      `  ${colorize(plugin.name, "cyan")} ${colorize(`v${plugin.version}`, "dim")}${authorTag}`,
    );
    console.log(`    ${plugin.description}`);
    console.log(
      `    ${colorize(`${plugin.toolCount} tools`, "dim")} | ${colorize(plugin.path, "dim")}`,
    );
    console.log();
  }
}

function printPluginDetail(plugin: PluginInfo): void {
  console.log(`\n  ${bold(plugin.name)} ${colorize(`v${plugin.version}`, "dim")}`);
  if (plugin.author) console.log(`  ${colorize("author:", "dim")} ${plugin.author}`);
  console.log(`  ${colorize("description:", "dim")} ${plugin.description}`);
  console.log(`  ${colorize("path:", "dim")} ${plugin.path}`);
  console.log(`  ${colorize("tools:", "dim")} ${plugin.toolCount}`);
  console.log();
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args[0] || "list";
  const pluginsDirectory = getPluginsDirectory();

  if (subcommand === "list") {
    step("installed plugins");
    if (!existsSync(pluginsDirectory)) {
      warn("no plugins directory found -- run 'kraken init' first");
      return;
    }
    printPluginList(listPlugins(pluginsDirectory));
    return;
  }

  if (subcommand === "inspect" && args[1]) {
    const candidatePath = resolve(pluginsDirectory, args[1]);
    if (!existsSync(candidatePath)) {
      fail(`plugin '${args[1]}' not found`);
      process.exit(1);
    }

    const info = inspectPlugin(candidatePath);
    if (!info) {
      fail(`could not read plugin at '${candidatePath}'`);
      process.exit(1);
    }

    printPluginDetail(info);
    return;
  }

  if (subcommand === "create" && args[1]) {
    if (!existsSync(pluginsDirectory)) {
      mkdirSync(pluginsDirectory, { recursive: true });
    }

    const pluginName = args[1];
    const pluginPath = join(pluginsDirectory, pluginName);

    if (existsSync(pluginPath)) {
      fail(`plugin '${pluginName}' already exists`);
      process.exit(1);
    }

    mkdirSync(pluginPath, { recursive: true });

    const template = `import type { KrakenPlugin } from "@kraken/sdk";

const plugin: KrakenPlugin = {
  name: "${pluginName}",
  version: "0.1.0",
  description: "A new kraken plugin",

  tools: [
    {
      definition: {
        name: "${pluginName}_tool",
        description: "Does something useful",
        parameters: {},
      },
      execute: async (_params, _context) => {
        return "Hello from ${pluginName}!";
      },
    },
  ],

  async activate(context) {
    console.log("[${pluginName}] activated");
  },

  async deactivate() {
    console.log("[${pluginName}] deactivated");
  },
};

export default plugin;
`;

    writeFileSync(join(pluginPath, "index.ts"), template);
    success(`created plugin '${pluginName}' at ${pluginPath}`);
    console.log(
      `\n  Edit ${colorize(`${pluginPath}/index.ts`, "cyan")} to customize your plugin.\n`,
    );
    return;
  }

  if (subcommand === "install" && args[1]) {
    const pluginName = args[1];
    step(`installing plugin "${pluginName}"`);

    try {
      const registry = await fetchRemoteRegistry();
      const entry = registry.plugins.find((p) => p.name === pluginName);

      if (!entry) {
        fail(`plugin "${pluginName}" not found in registry`);
        console.log(
          `\n  Available plugins: ${registry.plugins.map((p) => colorize(p.name, "cyan")).join(", ")}\n`,
        );
        process.exit(1);
      }

      const pluginPath = join(pluginsDirectory, entry.name);
      if (existsSync(pluginPath)) {
        warn(`plugin "${pluginName}" is already installed at ${pluginPath}`);
        return;
      }

      const sourceUrl = buildRawGitHubUrl(`packages/plugins/${entry.directory}/index.ts`);
      const sourceResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });

      if (!sourceResponse.ok) {
        fail(`failed to download plugin source (${sourceResponse.status})`);
        process.exit(1);
      }

      const sourceCode = await sourceResponse.text();

      mkdirSync(pluginPath, { recursive: true });
      writeFileSync(join(pluginPath, "index.ts"), sourceCode, "utf-8");
      success(`installed "${entry.name}" v${entry.version} to ${pluginPath}`);

      for (const requirement of entry.requires) {
        if (!checkCommandAvailable(requirement)) {
          warn(
            `required CLI tool "${requirement}" is not installed. Install it with: npm install -g ${requirement}`,
          );
        }
      }

      console.log(`\n  Restart kraken to load the new plugin.\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`installation failed: ${message}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === "search" || subcommand === "store") {
    step("available plugins");

    try {
      const registry = await fetchRemoteRegistry();
      const installed = existsSync(pluginsDirectory) ? listPlugins(pluginsDirectory) : [];
      const installedNames = new Set(installed.map((p) => p.name));

      console.log();
      for (const entry of registry.plugins) {
        const isInstalled = installedNames.has(entry.name);
        const statusIcon = isInstalled ? colorize("✓", "green") : colorize("○", "dim");
        const statusLabel = isInstalled ? colorize(" installed", "green") : "";
        console.log(
          `  ${statusIcon} ${colorize(entry.name, "cyan")} ${colorize(`v${entry.version}`, "dim")}${statusLabel}`,
        );
        console.log(`    ${entry.description}`);
        console.log(
          `    ${colorize(`${entry.tools.length} tools`, "dim")}${entry.requires.length > 0 ? colorize(` | requires: ${entry.requires.join(", ")}`, "dim") : ""}`,
        );
        console.log();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`failed to fetch registry: ${message}`);
      process.exit(1);
    }
    return;
  }

  console.log(`\n  ${bold("Usage:")}`);
  console.log(`    ${colorize("kraken plugins", "cyan")}                 list installed plugins`);
  console.log(
    `    ${colorize("kraken plugins search", "cyan")}           browse available plugins`,
  );
  console.log(
    `    ${colorize("kraken plugins install", "cyan")} <name>   install a plugin from the registry`,
  );
  console.log(`    ${colorize("kraken plugins inspect", "cyan")} <name>   show plugin details`);
  console.log(`    ${colorize("kraken plugins create", "cyan")} <name>    scaffold a new plugin\n`);
}
