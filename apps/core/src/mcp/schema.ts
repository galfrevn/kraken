export interface McpServerConfiguration {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpToolDefinition {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
