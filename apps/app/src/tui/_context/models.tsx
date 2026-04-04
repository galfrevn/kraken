import { useState, useEffect, useCallback } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import type {
  ModelInfo,
  ModelsEndpointResponse,
  ProviderModels,
  ModelSelection,
} from "@/models/types.ts";

export const { Provider: ModelsProvider, use: useModels } = createSimpleContext({
  name: "Models",
  init: () => {
    const sdk = useSdk();

    const [providers, setProviders] = useState<Record<string, ProviderModels>>({});
    const [selectedModel, setSelectedModel] = useState<ModelSelection>({
      modelId: "",
      providerId: "",
    });
    const [favorites, setFavorites] = useState<ModelSelection[]>([]);
    const [recents, setRecents] = useState<ModelSelection[]>([]);
    const [overriddenByEnvironment, setOverriddenByEnvironment] = useState(false);

    useEffect(() => {
      async function fetchModels() {
        try {
          const response = await sdk.client.fetch("/models");
          if (!response.ok) return;
          const responseData = (await response.json()) as ModelsEndpointResponse;
          setProviders(responseData.providers);
          setSelectedModel(responseData.current);
          setFavorites(responseData.favorites);
          setRecents(responseData.recents);
          setOverriddenByEnvironment(responseData.overriddenByEnvironment);
        } catch {}
      }
      fetchModels();
    }, []);

    useEffect(() => {
      const removeEventHandler = sdk.onEvent((eventType, eventData) => {
        if (eventType === "model.changed") {
          const modelChangePayload = eventData as ModelSelection;
          setSelectedModel(modelChangePayload);
        }
      });
      return removeEventHandler;
    }, [sdk]);

    const selectModel = useCallback(
      async (modelId: string, providerId: string) => {
        setSelectedModel({ modelId, providerId });
        try {
          await sdk.client.post("/models/select", { modelId, providerId });
        } catch {}
      },
      [sdk],
    );

    const toggleFavorite = useCallback(
      async (modelId: string, providerId: string) => {
        setFavorites((previousFavorites) => {
          const existingIndex = previousFavorites.findIndex(
            (favoriteEntry) =>
              favoriteEntry.modelId === modelId && favoriteEntry.providerId === providerId,
          );
          if (existingIndex >= 0) {
            return previousFavorites.filter((_, entryIndex) => entryIndex !== existingIndex);
          }
          return [...previousFavorites, { modelId, providerId }];
        });
        try {
          await sdk.client.post("/models/favorite", { modelId, providerId });
        } catch {}
      },
      [sdk],
    );

    const currentModelDisplayName = (() => {
      for (const providerModels of Object.values(providers)) {
        const matchingModel = providerModels.models.find(
          (model) =>
            model.id === selectedModel.modelId && model.providerId === selectedModel.providerId,
        );
        if (matchingModel) return matchingModel.name;
      }
      return selectedModel.modelId || "No model";
    })();

    const currentProviderDisplayName = (() => {
      const matchingProvider = providers[selectedModel.providerId];
      return matchingProvider?.name ?? selectedModel.providerId ?? "";
    })();

    const getModelInfo = useCallback(
      (modelId: string, providerId: string): ModelInfo | undefined => {
        const providerModels = providers[providerId];
        if (!providerModels) return undefined;
        return providerModels.models.find(
          (model) => model.id === modelId && model.providerId === providerId,
        );
      },
      [providers],
    );

    return {
      providers,
      current: selectedModel,
      favorites,
      recents,
      overriddenByEnvironment,
      selectModel,
      toggleFavorite,
      currentModelDisplayName,
      currentProviderDisplayName,
      getModelInfo,
    };
  },
});
