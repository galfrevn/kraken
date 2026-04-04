import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelsDevResponse } from "@/models/types.ts";

const REFRESH_INTERVAL_MILLISECONDS = 60 * 60 * 1000;

function getCacheDirectoryPath(): string {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(homeDirectory, ".kraken", "cache");
}

function getCacheFilePath(): string {
  return join(getCacheDirectoryPath(), "models.json");
}

let cachedModelsDevData: ModelsDevResponse | null = null;

async function fetchRemote(): Promise<ModelsDevResponse | null> {
  try {
    const response = await fetch("https://models.dev/api.json");
    if (!response.ok) return null;
    const responseData = (await response.json()) as ModelsDevResponse;
    return responseData;
  } catch {
    return null;
  }
}

function readLocalCache(): ModelsDevResponse | null {
  const cacheFilePath = getCacheFilePath();
  if (!existsSync(cacheFilePath)) return null;
  try {
    return JSON.parse(readFileSync(cacheFilePath, "utf-8")) as ModelsDevResponse;
  } catch {
    return null;
  }
}

function writeLocalCache(modelsData: ModelsDevResponse): void {
  const cacheDirectory = getCacheDirectoryPath();
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(getCacheFilePath(), JSON.stringify(modelsData), "utf-8");
}

async function loadBundledSnapshot(): Promise<ModelsDevResponse | null> {
  try {
    const snapshotModule = await import("@/models/snapshot.ts");
    return snapshotModule.snapshot as unknown as ModelsDevResponse;
  } catch {
    return null;
  }
}

export async function getModelsDevData(): Promise<ModelsDevResponse> {
  if (cachedModelsDevData) return cachedModelsDevData;

  const localCacheData = readLocalCache();
  if (localCacheData) {
    cachedModelsDevData = localCacheData;
    return localCacheData;
  }

  const snapshotData = await loadBundledSnapshot();
  if (snapshotData) {
    cachedModelsDevData = snapshotData;
    return snapshotData;
  }

  const remoteData = await fetchRemote();
  if (remoteData) {
    cachedModelsDevData = remoteData;
    writeLocalCache(remoteData);
    return remoteData;
  }

  return {};
}

export async function refreshModelsDevData(): Promise<void> {
  const remoteData = await fetchRemote();
  if (remoteData) {
    cachedModelsDevData = remoteData;
    writeLocalCache(remoteData);
  }
}

let refreshIntervalId: ReturnType<typeof setInterval> | null = null;

export function startModelsDevRefreshInterval(): void {
  refreshModelsDevData();
  refreshIntervalId = setInterval(refreshModelsDevData, REFRESH_INTERVAL_MILLISECONDS);

  process.on("exit", () => {
    if (refreshIntervalId) clearInterval(refreshIntervalId);
  });
}
