import { McpServerConnection } from "@/mcp/client.ts";
import type { McpServerConfiguration, McpToolDefinition } from "@/mcp/schema.ts";
import type { Tool, ToolExecutionContext, ToolResult, ToolParameterDefinition } from "@/tools/schema.ts";

export class McpToolRegistry {
  private serverConnections: Map<string, McpServerConnection> = new Map();
  private registeredTools: Tool[] = [];

  async connectToAllServers(
    serverConfigurations: McpServerConfiguration[],
  ): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
    const connectedServerNames: string[] = [];
    const failedServerConnections: Array<{ name: string; error: string }> = [];

    for (const serverConfiguration of serverConfigurations) {
      const serverConnection = new McpServerConnection(serverConfiguration);
      try {
        await serverConnection.connect();
        this.serverConnections.set(serverConfiguration.name, serverConnection);
        connectedServerNames.push(serverConfiguration.name);

        const discoveredToolDefinitions = serverConnection.getDiscoveredToolDefinitions();
        for (const toolDefinition of discoveredToolDefinitions) {
          this.registeredTools.push(
            this.convertMcpToolToKrakenTool(toolDefinition, serverConnection),
          );
        }
      } catch (connectionError) {
        const errorMessage = connectionError instanceof Error
          ? connectionError.message
          : String(connectionError);
        failedServerConnections.push({ name: serverConfiguration.name, error: errorMessage });
      }
    }

    return { connected: connectedServerNames, failed: failedServerConnections };
  }

  private convertMcpToolToKrakenTool(
    toolDefinition: McpToolDefinition,
    serverConnection: McpServerConnection,
  ): Tool {
    const qualifiedToolName = `mcp_${toolDefinition.serverName}_${toolDefinition.toolName}`;
    const toolParameterDefinitions = this.extractParameterDefinitions(toolDefinition.inputSchema);

    return {
      definition: {
        name: qualifiedToolName,
        description: `[MCP: ${toolDefinition.serverName}] ${toolDefinition.description}`,
        parameters: toolParameterDefinitions,
      },
      async execute(
        parameters: Record<string, unknown>,
        _context: ToolExecutionContext,
      ): Promise<ToolResult> {
        try {
          const callToolResult = await serverConnection.callTool(
            toolDefinition.toolName,
            parameters,
          );
          return {
            success: !callToolResult.isError,
            output: callToolResult.content,
            error: callToolResult.isError ? callToolResult.content : undefined,
          };
        } catch (executionError) {
          const errorMessage = executionError instanceof Error
            ? executionError.message
            : String(executionError);
          return { success: false, output: "", error: errorMessage };
        }
      },
    };
  }

  private extractParameterDefinitions(
    inputSchema: Record<string, unknown>,
  ): ToolParameterDefinition[] {
    const schemaProperties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const requiredParameterNames = (inputSchema.required ?? []) as string[];

    return Object.entries(schemaProperties).map(([parameterName, parameterSchema]) => {
      const rawSchemaType = typeof parameterSchema.type === "string" ? parameterSchema.type : "string";
      const normalizedParameterType: "string" | "number" | "boolean" =
        rawSchemaType === "integer" || rawSchemaType === "number" ? "number"
        : rawSchemaType === "boolean" ? "boolean"
        : "string";

      return {
        name: parameterName,
        type: normalizedParameterType,
        description: (parameterSchema.description as string) ?? "",
        required: requiredParameterNames.includes(parameterName),
      };
    });
  }

  getTools(): Tool[] {
    return [...this.registeredTools];
  }

  async disconnectAllServers(): Promise<void> {
    for (const serverConnection of this.serverConnections.values()) {
      try {
        await serverConnection.disconnect();
      } catch {
        // best-effort cleanup
      }
    }
    this.serverConnections.clear();
    this.registeredTools = [];
  }

  getConnectedServerNames(): string[] {
    return Array.from(this.serverConnections.keys());
  }
}
