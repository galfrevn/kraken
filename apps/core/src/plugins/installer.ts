import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";

const KRAKEN_HOME = resolve(homedir(), ".kraken");
const GITHUB_REPO = "galfrevn/kraken";
const GITHUB_BRANCH = "main";

export interface RegistryPluginEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  tools: string[];
  requires: string[];
  directory: string;
}

export interface PluginRegistryManifest {
  version: number;
  plugins: RegistryPluginEntry[];
}

function buildRawGitHubUrl(filePath: string): string {
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}`;
}

export async function fetchRegistry(): Promise<PluginRegistryManifest> {
  const registryUrl = buildRawGitHubUrl("packages/plugins/registry.json");

  const response = await fetch(registryUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch plugin registry (${response.status}): ${await response.text()}`,
    );
  }

  return (await response.json()) as PluginRegistryManifest;
}

export function getInstalledPluginNames(): string[] {
  const pluginsDirectory = resolve(KRAKEN_HOME, "plugins");
  if (!existsSync(pluginsDirectory)) return [];

  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const entries = readdirSync(pluginsDirectory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const indexTs = resolve(pluginsDirectory, entry.name, "index.ts");
      const indexJs = resolve(pluginsDirectory, entry.name, "index.js");
      return existsSync(indexTs) || existsSync(indexJs);
    })
    .map((entry) => entry.name);
}

export function isPluginInstalled(pluginName: string): boolean {
  return getInstalledPluginNames().includes(pluginName);
}

function checkCommandAvailable(command: string): boolean {
  try {
    const cmd = process.platform === "win32" ? ["cmd", "/c", "where", command] : ["which", command];
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export interface InstallResult {
  success: boolean;
  pluginName: string;
  installPath: string;
  warnings: string[];
  error?: string;
}

export function ensureSdkResolvable(): void {
  const pluginsDirectory = resolve(KRAKEN_HOME, "plugins");
  const nodeModulesDir = resolve(pluginsDirectory, "node_modules", "@kraken");
  const sdkLinkPath = resolve(nodeModulesDir, "sdk");

  if (existsSync(sdkLinkPath)) return;

  // Find the SDK package in the monorepo workspace
  // Walk up from this file to find packages/sdk
  let searchDir = dirname(dirname(dirname(dirname(__dirname)))); // apps/core -> project root
  const candidates = [
    resolve(searchDir, "packages", "sdk"),
    resolve(searchDir, "..", "packages", "sdk"),
  ];

  // Also try resolving via require
  let sdkSourcePath: string | undefined;
  try {
    const sdkIndex = require.resolve("@kraken/sdk");
    // sdkIndex points to packages/sdk/src/index.ts, go up to packages/sdk
    sdkSourcePath = dirname(dirname(sdkIndex));
  } catch {
    // fallback to candidates
  }

  if (!sdkSourcePath) {
    for (const candidate of candidates) {
      if (existsSync(resolve(candidate, "package.json"))) {
        sdkSourcePath = candidate;
        break;
      }
    }
  }

  if (!sdkSourcePath) return;

  mkdirSync(nodeModulesDir, { recursive: true });

  try {
    // On Windows, directory symlinks may need elevated permissions.
    // Try symlink first, fall back to junction (works without admin on Windows).
    try {
      symlinkSync(sdkSourcePath, sdkLinkPath, "junction");
    } catch {
      symlinkSync(sdkSourcePath, sdkLinkPath, "dir");
    }
  } catch {
    // If symlink fails entirely, copy the SDK files instead
    const srcDir = resolve(sdkSourcePath, "src");
    if (existsSync(srcDir)) {
      mkdirSync(sdkLinkPath, { recursive: true });
      const sdkPkgJson = resolve(sdkSourcePath, "package.json");
      if (existsSync(sdkPkgJson)) {
        const { copyFileSync } = require("node:fs") as typeof import("node:fs");
        copyFileSync(sdkPkgJson, resolve(sdkLinkPath, "package.json"));
        const sdkSrcDir = resolve(sdkLinkPath, "src");
        mkdirSync(sdkSrcDir, { recursive: true });
        for (const file of ["index.ts", "types.ts"]) {
          const src = resolve(srcDir, file);
          if (existsSync(src)) {
            copyFileSync(src, resolve(sdkSrcDir, file));
          }
        }
      }
    }
  }
}

export async function installPluginFromRegistry(pluginName: string): Promise<InstallResult> {
  const registry = await fetchRegistry();
  const entry = registry.plugins.find((p) => p.name === pluginName);

  if (!entry) {
    return {
      success: false,
      pluginName,
      installPath: "",
      warnings: [],
      error: `Plugin "${pluginName}" not found in registry. Available: ${registry.plugins.map((p) => p.name).join(", ")}`,
    };
  }

  ensureSdkResolvable();

  const pluginDirectory = resolve(KRAKEN_HOME, "plugins", entry.name);
  const indexPath = resolve(pluginDirectory, "index.ts");

  const sourceUrl = buildRawGitHubUrl(`packages/plugins/${entry.directory}/index.ts`);
  const sourceResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });

  if (!sourceResponse.ok) {
    return {
      success: false,
      pluginName,
      installPath: "",
      warnings: [],
      error: `Failed to download plugin source (${sourceResponse.status})`,
    };
  }

  const sourceCode = await sourceResponse.text();

  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(indexPath, sourceCode, "utf-8");

  const warnings: string[] = [];
  for (const requirement of entry.requires) {
    if (!checkCommandAvailable(requirement)) {
      warnings.push(
        `Required CLI tool "${requirement}" is not installed. Install it with: npm install -g ${requirement}`,
      );
    }
  }

  return {
    success: true,
    pluginName: entry.name,
    installPath: pluginDirectory,
    warnings,
  };
}
