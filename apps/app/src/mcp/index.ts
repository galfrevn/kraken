import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { tool as vercelTool } from "ai";
import { jsonSchema } from "ai";

const MCP_DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MCP_CLIENT_NAME = "kraken";
const MCP_CLIENT_VERSION = "0.1.0";

type McpServerStatus = "connected" | "disabled" | "failed";

interface McpServerEntry {
  name: string;
  client: Client | null;
  status: McpServerStatus;
  errorMessage?: string;
}

interface McpConfigEntry {
  type: "local" | "remote";
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

const connectedServers: Map<string, McpServerEntry> = new Map();

function substituteEnvironmentVariables(input: string): string {
  return input.replace(/\$\{(\w+)\}/g, (_match, variableName) => {
    return process.env[variableName] ?? "";
  });
}

function substituteHeaderValues(headers: Record<string, string>): Record<string, string> {
  const substitutedHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    substitutedHeaders[headerName] = substituteEnvironmentVariables(headerValue);
  }
  return substitutedHeaders;
}

async function connectLocalServer(
  serverName: string,
  command: string[],
  environment: Record<string, string>,
  timeoutMilliseconds: number,
): Promise<McpServerEntry> {
  const [executable, ...commandArguments] = command;
  if (!executable) {
    return {
      name: serverName,
      client: null,
      status: "failed",
      errorMessage: "empty command array",
    };
  }

  const transport = new StdioClientTransport({
    command: executable,
    args: commandArguments,
    env: { ...process.env, ...environment } as Record<string, string>,
  });

  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );

  try {
    const connectSignal = AbortSignal.timeout(timeoutMilliseconds);
    await client.connect(transport);
    await client.listTools({ _meta: { progressToken: undefined }, signal: connectSignal } as never);
    return { name: serverName, client, status: "connected" };
  } catch (connectionError) {
    try {
      await client.close();
    } catch {}
    return {
      name: serverName,
      client: null,
      status: "failed",
      errorMessage: String(connectionError),
    };
  }
}

async function connectRemoteServer(
  serverName: string,
  url: string,
  headers: Record<string, string>,
  timeoutMilliseconds: number,
): Promise<McpServerEntry> {
  const substitutedHeaders = substituteHeaderValues(headers);
  const serverUrl = new URL(url);
  const requestInit = { headers: substitutedHeaders };

  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );

  try {
    const streamableSignal = AbortSignal.timeout(timeoutMilliseconds);
    const streamableTransport = new StreamableHTTPClientTransport(serverUrl, { requestInit });
    await client.connect(streamableTransport);
    await client.listTools({
      _meta: { progressToken: undefined },
      signal: streamableSignal,
    } as never);
    return { name: serverName, client, status: "connected" };
  } catch {
    try {
      await client.close();
    } catch {}
  }

  const fallbackClient = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );

  try {
    const sseSignal = AbortSignal.timeout(timeoutMilliseconds);
    const sseTransport = new SSEClientTransport(serverUrl, { requestInit });
    await fallbackClient.connect(sseTransport);
    await fallbackClient.listTools({
      _meta: { progressToken: undefined },
      signal: sseSignal,
    } as never);
    return { name: serverName, client: fallbackClient, status: "connected" };
  } catch (connectionError) {
    try {
      await fallbackClient.close();
    } catch {}
    return {
      name: serverName,
      client: null,
      status: "failed",
      errorMessage: String(connectionError),
    };
  }
}

function sanitizeToolName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, "_");
}

export async function initializeMcpServers(): Promise<void> {
  const krakenJsoncPath =
    process.env.KRAKEN_CONFIGURATION_FILE ?? `${process.env.HOME ?? "."}/.kraken/kraken.jsonc`;

  let mcpConfig: Record<string, McpConfigEntry> = {};

  try {
    const { existsSync, readFileSync } = await import("node:fs");
    if (existsSync(krakenJsoncPath)) {
      const { stripJsoncComments } = await import("@/config/index.ts");
      const rawContent = readFileSync(krakenJsoncPath, "utf-8");
      const parsed = JSON.parse(stripJsoncComments(rawContent));
      mcpConfig = parsed.mcp ?? {};
    }
  } catch {
    return;
  }

  const connectionPromises: Promise<void>[] = [];

  for (const [serverName, serverConfig] of Object.entries(mcpConfig)) {
    if (serverConfig.enabled === false) {
      connectedServers.set(serverName, {
        name: serverName,
        client: null,
        status: "disabled",
      });
      continue;
    }

    const timeoutMilliseconds = serverConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MILLISECONDS;

    const connectionPromise = (async () => {
      let entry: McpServerEntry;

      if (serverConfig.type === "local" && serverConfig.command) {
        entry = await connectLocalServer(
          serverName,
          serverConfig.command,
          serverConfig.environment ?? {},
          timeoutMilliseconds,
        );
      } else if (serverConfig.type === "remote" && serverConfig.url) {
        entry = await connectRemoteServer(
          serverName,
          serverConfig.url,
          serverConfig.headers ?? {},
          timeoutMilliseconds,
        );
      } else {
        entry = {
          name: serverName,
          client: null,
          status: "failed",
          errorMessage: `invalid config: type="${serverConfig.type}"`,
        };
      }

      connectedServers.set(serverName, entry);

      if (entry.status === "connected") {
        console.log(`[mcp] connected: ${serverName}`);
      } else if (entry.status === "failed") {
        console.warn(`[mcp] failed: ${serverName} -- ${entry.errorMessage}`);
      }
    })();

    connectionPromises.push(connectionPromise);
  }

  await Promise.allSettled(connectionPromises);
}

let cachedMcpTools: Record<string, ReturnType<typeof vercelTool>> | null = null;

export async function getMcpTools(): Promise<Record<string, ReturnType<typeof vercelTool>>> {
  if (cachedMcpTools) return cachedMcpTools;

  const mcpTools: Record<string, ReturnType<typeof vercelTool>> = {};

  const activeServers = Array.from(connectedServers.entries()).filter(
    ([, entry]) => entry.status === "connected" && entry.client,
  );

  const results = await Promise.allSettled(
    activeServers.map(async ([serverName, serverEntry]) => {
      const toolListResponse = await serverEntry.client!.listTools({
        _meta: { progressToken: undefined },
      });
      return { serverName, client: serverEntry.client!, tools: toolListResponse.tools };
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn(`[mcp] failed to list tools: ${result.reason}`);
      continue;
    }

    const { serverName, client: mcpClient, tools } = result.value;
    for (const mcpToolDefinition of tools) {
      const qualifiedToolName = `${sanitizeToolName(serverName)}_${sanitizeToolName(mcpToolDefinition.name)}`;

      const inputSchemaForTool = {
        ...mcpToolDefinition.inputSchema,
        type: "object" as const,
        additionalProperties: false,
      };

      mcpTools[qualifiedToolName] = vercelTool({
        description: mcpToolDefinition.description ?? qualifiedToolName,
        parameters: jsonSchema(inputSchemaForTool),
        execute: async (args: unknown, options: { abortSignal?: AbortSignal } = {}) => {
          const abortSignal = options.abortSignal;
          const callResult = await mcpClient.callTool(
            {
              name: mcpToolDefinition.name,
              arguments: args as Record<string, unknown>,
            },
            undefined,
            { signal: abortSignal } as never,
          );

          const textContent = (callResult.content as Array<{ type: string; text?: string }>)
            .filter((block) => block.type === "text" && block.text)
            .map((block) => block.text)
            .join("\n");

          return { content: textContent || "(no output)" };
        },
      }) as unknown as ReturnType<typeof vercelTool>;
    }
  }

  cachedMcpTools = mcpTools;
  return mcpTools;
}

export function getMcpServerStatuses(): Array<{
  name: string;
  status: McpServerStatus;
  error?: string;
}> {
  return Array.from(connectedServers.values()).map((entry) => ({
    name: entry.name,
    status: entry.status,
    error: entry.errorMessage,
  }));
}

export async function shutdownMcpServers(): Promise<void> {
  cachedMcpTools = null;
  for (const [_serverName, serverEntry] of connectedServers) {
    if (serverEntry.client) {
      try {
        await serverEntry.client.close();
      } catch {}
    }
  }
  connectedServers.clear();
}
