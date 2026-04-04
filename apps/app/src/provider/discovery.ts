import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { ModelInfo } from "@/models/types.ts";
import { getConfiguredProviders } from "./index.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".kraken", "cache", "models.json");
}

interface CachedModels {
  timestamp: number;
  models: ModelInfo[];
}

let memoryCache: CachedModels | null = null;

function readDiskCache(): CachedModels | null {
  const path = cacheFilePath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as CachedModels;
    if (Date.now() - data.timestamp < CACHE_TTL_MS) return data;
    return null;
  } catch {
    return null;
  }
}

function writeDiskCache(models: ModelInfo[]): void {
  const path = cacheFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ timestamp: Date.now(), models }));
  } catch {
    // non-critical
  }
}

export async function discoverModels(forceRefresh = false): Promise<ModelInfo[]> {
  if (!forceRefresh && memoryCache) return memoryCache.models;

  if (!forceRefresh) {
    const disk = readDiskCache();
    if (disk) {
      memoryCache = disk;
      return disk.models;
    }
  }

  const providers = getConfiguredProviders();
  const results = await Promise.allSettled(providers.map((p) => p.listModels()));

  const models = results
    .filter((r): r is PromiseFulfilledResult<ModelInfo[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);

  memoryCache = { timestamp: Date.now(), models };
  writeDiskCache(models);

  return models;
}

export function invalidateModelDiscoveryCache(): void {
  memoryCache = null;
}
