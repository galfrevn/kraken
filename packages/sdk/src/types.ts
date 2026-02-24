export interface ToolParameterDefinition {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterDefinition[];
}

export interface ToolExecutionContext {
  workingDirectory: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(parameters: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface PluginContext {
  workingDirectory: string;
  databasePath: string;
  config: Record<string, unknown>;
}

export interface PluginHooks {
  onConversationStart?: (context: PluginContext) => Promise<void> | void;
  onConversationEnd?: (context: PluginContext) => Promise<void> | void;
  beforeToolCall?: (
    toolName: string,
    parameters: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  afterToolCall?: (
    toolName: string,
    parameters: Record<string, unknown>,
    result: ToolResult,
  ) => Promise<void> | void;
}

export interface PluginConfigField {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface KrakenPlugin {
  name: string;
  version: string;
  description?: string;
  author?: string;
  toolDisplayNames?: Record<string, string>;
  configSchema?: Record<string, PluginConfigField>;
  tools?: Tool[];
  hooks?: PluginHooks;
  promptExtension?: string;
  activate?: (context: PluginContext) => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
}
