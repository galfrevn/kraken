// models.dev/api.json structure: Record<providerId, ModelsDevProvider>
// e.g. { "openrouter": { id, name, models: { "model-id": { ... } } }, "anthropic": { ... } }

export interface ModelsDevModelEntry {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  cost?: { input: number; output: number };
  limit?: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, ModelsDevModelEntry>;
}

export type ModelsDevResponse = Record<string, ModelsDevProvider>;

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  contextLength: number;
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
