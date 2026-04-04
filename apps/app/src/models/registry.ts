import { getModelsDevData } from "@/models/modelsdev.ts";
import type {
  ModelInfo,
  ProviderModels,
  ModelsDevProvider,
  ModelsDevModelEntry,
} from "@/models/types.ts";

interface KrakenProviderMapping {
  modelsDevProviderId: string;
  krakenProviderId: string;
  environmentVariables: string[];
  transformModelId: (modelsDevModelId: string) => string;
}

const krakenProviderMappings: KrakenProviderMapping[] = [
  {
    modelsDevProviderId: "openrouter",
    krakenProviderId: "openrouter",
    environmentVariables: ["KRAKEN_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
    transformModelId: (modelsDevModelId: string) => modelsDevModelId,
  },
  {
    modelsDevProviderId: "anthropic",
    krakenProviderId: "anthropic",
    environmentVariables: ["ANTHROPIC_API_KEY"],
    transformModelId: (modelsDevModelId: string) => modelsDevModelId,
  },
  {
    modelsDevProviderId: "openai",
    krakenProviderId: "openai",
    environmentVariables: ["OPENAI_API_KEY"],
    transformModelId: (modelsDevModelId: string) => modelsDevModelId,
  },
];

function isProviderConnected(mapping: KrakenProviderMapping): boolean {
  return mapping.environmentVariables.some(
    (environmentVariable) => !!process.env[environmentVariable],
  );
}

function convertToModelInfo(
  modelsDevModelEntry: ModelsDevModelEntry,
  krakenProviderId: string,
  providerDisplayName: string,
  transformModelId: (id: string) => string,
): ModelInfo {
  return {
    id: transformModelId(modelsDevModelEntry.id),
    name: modelsDevModelEntry.name || modelsDevModelEntry.id,
    providerId: krakenProviderId,
    providerName: providerDisplayName,
    contextLength: modelsDevModelEntry.limit?.context ?? 0,
    cost: modelsDevModelEntry.cost
      ? {
          input: modelsDevModelEntry.cost.input,
          output: modelsDevModelEntry.cost.output,
        }
      : undefined,
  };
}

export async function getAvailableModels(): Promise<Record<string, ProviderModels>> {
  const modelsDevData = await getModelsDevData();
  const availableModelsByProvider: Record<string, ProviderModels> = {};

  for (const mapping of krakenProviderMappings) {
    if (!isProviderConnected(mapping)) continue;

    const modelsDevProvider = modelsDevData[mapping.modelsDevProviderId] as
      | ModelsDevProvider
      | undefined;
    if (!modelsDevProvider?.models) continue;

    const providerModelsList: ModelInfo[] = [];

    for (const modelsDevModelEntry of Object.values(modelsDevProvider.models)) {
      if (!modelsDevModelEntry?.id || !modelsDevModelEntry?.name) continue;

      const modelInfo = convertToModelInfo(
        modelsDevModelEntry,
        mapping.krakenProviderId,
        modelsDevProvider.name || mapping.modelsDevProviderId,
        mapping.transformModelId,
      );
      providerModelsList.push(modelInfo);
    }

    if (providerModelsList.length > 0) {
      providerModelsList.sort((modelA, modelB) => modelA.name.localeCompare(modelB.name));
      availableModelsByProvider[mapping.krakenProviderId] = {
        name: modelsDevProvider.name || mapping.modelsDevProviderId,
        models: providerModelsList,
      };
    }
  }

  return availableModelsByProvider;
}
