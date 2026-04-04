export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  contextLength?: number;
  cost?: { input: number; output: number };
}

export interface ProviderModels {
  name: string;
  models: ModelInfo[];
}

export interface ModelSelection {
  modelId: string;
  providerId: string;
}

export interface ModelState {
  current: ModelSelection;
  favorites: ModelSelection[];
  recents: ModelSelection[];
}

export interface ModelsEndpointResponse {
  providers: Record<string, ProviderModels>;
  current: ModelSelection;
  favorites: ModelSelection[];
  recents: ModelSelection[];
  overriddenByEnvironment: boolean;
}
