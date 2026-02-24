export type {
  Tool,
  ToolDefinition,
  ToolParameterDefinition,
  ToolExecutionContext,
  ToolResult,
  PluginContext,
  PluginHooks,
  PluginConfigField,
  KrakenPlugin,
} from "./types.ts";

import type { KrakenPlugin } from "./types.ts";

export function definePlugin(plugin: KrakenPlugin): KrakenPlugin {
  return plugin;
}
