import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

function allowlistPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".kraken", "state", "permissions.json");
}

let cache: Record<string, boolean> | null = null;

function loadAllowlist(): Record<string, boolean> {
  if (cache) return cache;
  const path = allowlistPath();
  if (!existsSync(path)) {
    cache = {};
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(path, "utf-8")) as Record<string, boolean>;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

function saveAllowlist(data: Record<string, boolean>): void {
  const path = allowlistPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {
    // non-critical
  }
}

function buildKey(toolId: string, target: string): string {
  return `${toolId}:${target}`;
}

export function isAllowed(toolId: string, target: string): boolean {
  const list = loadAllowlist();
  return list[buildKey(toolId, target)] === true;
}

export function addAllowRule(toolId: string, target: string): void {
  const list = loadAllowlist();
  list[buildKey(toolId, target)] = true;
  cache = list;
  saveAllowlist(list);
}
