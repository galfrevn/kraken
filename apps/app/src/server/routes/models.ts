import { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAvailableModels } from "@/models/registry.ts";
import { loadConfig, resetConfig } from "@/config/index.ts";
import { Bus, Events } from "@/bus/index.ts";
import type { ModelState, ModelSelection, ModelsEndpointResponse } from "@/models/types.ts";

function getModelStatePath(): string {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(homeDirectory, ".kraken", "cache", "modelstate.json");
}

function readModelState(): ModelState {
  const modelStatePath = getModelStatePath();
  if (existsSync(modelStatePath)) {
    try {
      return JSON.parse(readFileSync(modelStatePath, "utf-8")) as ModelState;
    } catch {}
  }
  const config = loadConfig();
  return {
    current: { modelId: config.model, providerId: config.provider },
    favorites: [],
    recents: [],
  };
}

function writeModelState(modelState: ModelState): void {
  const modelStatePath = getModelStatePath();
  const cacheDirectory = join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".kraken",
    "cache",
  );
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(modelStatePath, JSON.stringify(modelState, null, 2), "utf-8");
}

function resolveCurrentModel(modelState: ModelState): ModelSelection {
  const config = loadConfig();
  const environmentModelId = process.env.KRAKEN_MODEL;
  const environmentProviderId = process.env.KRAKEN_PROVIDER;
  if (environmentModelId || environmentProviderId) {
    return {
      modelId: environmentModelId ?? config.model,
      providerId: environmentProviderId ?? config.provider,
    };
  }
  return modelState.current;
}

const MAX_RECENT_MODELS = 10;

export const modelsRouter = new Hono();

modelsRouter.get("/models", async (context) => {
  const availableProviders = await getAvailableModels();
  const modelState = readModelState();
  const currentSelection = resolveCurrentModel(modelState);
  const overriddenByEnvironment = !!(process.env.KRAKEN_MODEL || process.env.KRAKEN_PROVIDER);

  const responsePayload: ModelsEndpointResponse = {
    providers: availableProviders,
    current: currentSelection,
    favorites: modelState.favorites,
    recents: modelState.recents,
    overriddenByEnvironment,
  };

  return context.json(responsePayload);
});

modelsRouter.post("/models/select", async (context) => {
  let requestBody: ModelSelection;
  try {
    requestBody = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  const { modelId, providerId } = requestBody;

  if (!modelId || !providerId) {
    return context.json({ error: "modelId and providerId are required" }, 400);
  }

  const availableProviders = await getAvailableModels();
  const targetProvider = availableProviders[providerId];
  if (!targetProvider) {
    return context.json({ error: `Unknown or disconnected provider: ${providerId}` }, 400);
  }

  const targetModel = targetProvider.models.find((model) => model.id === modelId);
  if (!targetModel) {
    return context.json({ error: `Model ${modelId} not found for provider ${providerId}` }, 400);
  }

  const modelState = readModelState();
  modelState.current = { modelId, providerId };

  const deduplicatedRecents = modelState.recents.filter(
    (recentEntry) => !(recentEntry.modelId === modelId && recentEntry.providerId === providerId),
  );
  deduplicatedRecents.unshift({ modelId, providerId });
  modelState.recents = deduplicatedRecents.slice(0, MAX_RECENT_MODELS);

  writeModelState(modelState);
  resetConfig();

  Bus.publish(Events.Model.Changed, { modelId, providerId });

  return context.json({ ok: true });
});

modelsRouter.post("/models/favorite", async (context) => {
  let requestBody: ModelSelection;
  try {
    requestBody = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  const { modelId, providerId } = requestBody;

  if (!modelId || !providerId) {
    return context.json({ error: "modelId and providerId are required" }, 400);
  }

  const modelState = readModelState();
  const existingFavoriteIndex = modelState.favorites.findIndex(
    (favoriteEntry) => favoriteEntry.modelId === modelId && favoriteEntry.providerId === providerId,
  );

  if (existingFavoriteIndex >= 0) {
    modelState.favorites.splice(existingFavoriteIndex, 1);
  } else {
    modelState.favorites.push({ modelId, providerId });
  }

  writeModelState(modelState);

  return context.json({ ok: true, favorited: existingFavoriteIndex < 0 });
});
