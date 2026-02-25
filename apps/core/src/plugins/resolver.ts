import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

export interface PluginEntry {
  path: string;
  config: Record<string, unknown>;
}

export interface ResolvedPlugin {
  entry: string;
  absolutePath: string;
  source: "local" | "npm";
  config: Record<string, unknown>;
}

function isLocalPath(entry: string): boolean {
  return (
    entry.startsWith("./") ||
    entry.startsWith("../") ||
    entry.startsWith("/") ||
    entry.startsWith(".kraken/")
  );
}

function resolveLocalPlugin(
  entry: string,
  workingDirectory: string,
): Omit<ResolvedPlugin, "config"> | undefined {
  const absolutePath = isAbsolute(entry) ? entry : resolve(workingDirectory, entry);

  const candidates = [
    resolve(absolutePath, "index.ts"),
    resolve(absolutePath, "index.js"),
    absolutePath + ".ts",
    absolutePath + ".js",
    absolutePath,
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { entry, absolutePath: candidate, source: "local" };
    }
  }

  return undefined;
}

function resolveNpmPlugin(
  entry: string,
  workingDirectory: string,
): Omit<ResolvedPlugin, "config"> | undefined {
  try {
    const resolved = require.resolve(entry, { paths: [workingDirectory] });
    return { entry, absolutePath: resolved, source: "npm" };
  } catch {
    return undefined;
  }
}

export function resolvePluginPaths(
  entries: PluginEntry[],
  workingDirectory: string,
): { resolved: ResolvedPlugin[]; failed: string[] } {
  const resolved: ResolvedPlugin[] = [];
  const failed: string[] = [];

  for (const entry of entries) {
    const result = isLocalPath(entry.path)
      ? resolveLocalPlugin(entry.path, workingDirectory)
      : resolveNpmPlugin(entry.path, workingDirectory);

    if (result) {
      resolved.push({ ...result, config: entry.config });
    } else {
      failed.push(entry.path);
    }
  }

  return { resolved, failed };
}
