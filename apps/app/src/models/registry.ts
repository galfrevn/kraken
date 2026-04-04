import { discoverModels } from "@/provider/discovery.ts";
import type { ProviderModels } from "@/models/types.ts";

export async function getAvailableModels(): Promise<Record<string, ProviderModels>> {
  const allModels = await discoverModels();
  const byProvider: Record<string, ProviderModels> = {};

  for (const model of allModels) {
    if (!byProvider[model.providerId]) {
      byProvider[model.providerId] = {
        name: model.providerName,
        models: [],
      };
    }
    byProvider[model.providerId]!.models.push(model);
  }

  for (const provider of Object.values(byProvider)) {
    provider.models.sort((a, b) => a.name.localeCompare(b.name));
  }

  return byProvider;
}
