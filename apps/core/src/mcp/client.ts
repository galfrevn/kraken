import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfiguration, McpToolDefinition } from "@/mcp/schema.ts";

export class McpServerConnection {
  private serverConfiguration: McpServerConfiguration;
  private mcpClient: Client | null = null;
  private stdioTransport: StdioClientTransport | null = null;
  private discoveredToolDefinitions: McpToolDefinition[] = [];

  constructor(serverConfiguration: McpServerConfiguration) {
    this.serverConfiguration = serverConfiguration;
  }

  async connect(): Promise<void> {
    this.stdioTransport = new StdioClientTransport({
      command: this.serverConfiguration.command,
      args: this.serverConfiguration.args,
      env: this.serverConfiguration.env
        ? { ...process.env, ...this.serverConfiguration.env } as Record<string, string>
        : undefined,
    });

    this.mcpClient = new Client(
      { name: "kraken", version: "0.1.0" },
      { capabilities: {} },
    );

    await this.mcpClient.connect(this.stdioTransport);
    await this.discoverTools();
  }

  private async discoverTools(): Promise<void> {
    if (!this.mcpClient) return;

    const toolListResponse = await this.mcpClient.listTools();
    this.discoveredToolDefinitions = toolListResponse.tools.map((mcpTool: { name: string; description?: string; inputSchema: unknown }) => ({
      serverName: this.serverConfiguration.name,
      toolName: mcpTool.name,
      description: mcpTool.description ?? "",
      inputSchema: mcpTool.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(
    toolName: string,
    toolArguments: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    if (!this.mcpClient) {
      return { content: "MCP server not connected", isError: true };
    }

    const callToolResponse = await this.mcpClient.callTool({
      name: toolName,
      arguments: toolArguments,
    });

    const contentParts = (callToolResponse.content as Array<{ type: string; text?: string }>) ?? [];
    const textContent = contentParts
      .filter((contentPart) => contentPart.type === "text" && contentPart.text)
      .map((contentPart) => contentPart.text!)
      .join("\n");

    return {
      content: textContent || JSON.stringify(callToolResponse.content),
      isError: callToolResponse.isError === true,
    };
  }

  getDiscoveredToolDefinitions(): McpToolDefinition[] {
    return [...this.discoveredToolDefinitions];
  }

  getServerName(): string {
    return this.serverConfiguration.name;
  }

  async disconnect(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }
    this.stdioTransport = null;
  }
}
