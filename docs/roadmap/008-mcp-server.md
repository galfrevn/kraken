# Kraken MCP Server

## Summary

Expose Kraken's capabilities as an MCP (Model Context Protocol) server. This allows external agents (Claude Desktop, Cursor, Windsurf, other MCP clients) to use Kraken as a tool provider — scheduling tasks, searching code, querying the dependency graph, reading session history, etc. The app already has `@modelcontextprotocol/sdk` as a dependency and a full MCP client implementation (`src/mcp/index.ts`).

## Motivation

MCP is becoming the standard protocol for AI tool interoperability. Making Kraken an MCP server means:
- Any MCP-compatible agent can schedule tasks on Kraken's daemon.
- Users can add Kraken as an MCP server in Claude Desktop, Cursor, etc.
- Kraken's persistent features (cron, watchers, webhooks) become available to any agent.
- The code analysis features (AST, search, graph) can serve multiple clients.

## Current State

- `apps/app/src/mcp/index.ts` implements a full **MCP client**: connects to local (stdio) and remote (SSE) MCP servers, discovers tools, wraps them as Vercel AI SDK tools.
- `@modelcontextprotocol/sdk` is already in `apps/app/package.json`.
- The daemon exposes an HTTP API on port 50051 with task, secret, trigger, and stats endpoints.
- No MCP server implementation exists.

## Architecture

### Option A: New App in Monorepo (Recommended)

```
apps/mcp-server/
  package.json
  src/
    index.ts          -- MCP server entry point
    tools/
      tasks.ts        -- schedule, list, cancel, retry tasks
      search.ts       -- code search (text + semantic)
      symbols.ts      -- AST symbol queries
      graph.ts        -- dependency graph queries
      sessions.ts     -- session/conversation access
      secrets.ts      -- secret management
    resources/
      config.ts       -- expose kraken.jsonc as MCP resource
      stats.ts        -- daemon stats as MCP resource
    prompts/
      review.ts       -- pre-built prompt templates
```

### Option B: Embedded in App

Add MCP server transport to the existing app's Hono server. Simpler but couples the MCP server lifecycle to the TUI.

**Recommendation**: Option A — separate process, can run independently, easier to configure in MCP clients.

### MCP Tools to Expose

#### Task Management

```typescript
server.tool("schedule_task", {
  description: "Schedule a task for Kraken's autonomous agent to execute. Supports immediate, delayed (run_at), and recurring (cron) execution.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task description / prompt for the agent" },
      cron_expression: { type: "string", description: "Cron expression for recurring tasks (e.g. '0 9 * * *')" },
      run_at: { type: "string", description: "ISO 8601 datetime to run the task at" },
      priority: { type: "number", description: "Task priority (1-10, lower = higher priority)" },
      agent: { type: "string", enum: ["build", "plan"], description: "Agent to use" },
    },
    required: ["prompt"],
  },
  handler: async (args) => {
    const response = await fetch(`${DAEMON_URL}/api/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return { content: [{ type: "text", text: JSON.stringify(await response.json()) }] };
  },
});
```

#### Full Tool List

| Tool Name | Description |
|-----------|-------------|
| `schedule_task` | Schedule immediate, delayed, or recurring tasks |
| `list_tasks` | List tasks with status/limit/offset filters |
| `get_task` | Get task details including output and logs |
| `cancel_task` | Cancel a running or pending task |
| `retry_task` | Retry a failed task |
| `search_code` | Full-text code search across the repo |
| `semantic_search` | Semantic code search (if embeddings are enabled) |
| `get_symbols` | Get file symbols/outline (if tree-sitter is enabled) |
| `get_dependencies` | Get file dependencies/dependents (if graph is enabled) |
| `list_sessions` | List agent conversation sessions |
| `get_session_messages` | Get messages from a session |
| `get_stats` | Get daemon stats (tasks, uptime, costs) |
| `manage_secret` | Get/set/delete secrets in the daemon's store |
| `list_triggers` | List configured triggers (crons, watchers, webhooks) |
| `get_health` | Check daemon and app health |

### MCP Resources to Expose

```typescript
server.resource("kraken://config", {
  name: "Kraken Configuration",
  description: "Current daemon configuration (kraken.jsonc)",
  mimeType: "application/json",
  handler: async () => {
    // Read and return sanitized config (strip secrets)
  },
});

server.resource("kraken://stats", {
  name: "Daemon Statistics",
  description: "Current daemon statistics including task counts and uptime",
  mimeType: "application/json",
  handler: async () => {
    const response = await fetch(`${DAEMON_URL}/api/stats`);
    return await response.json();
  },
});
```

### MCP Prompts

Pre-built prompt templates that MCP clients can use:

```typescript
server.prompt("review-pr", {
  description: "Review a pull request",
  arguments: [
    { name: "pr_number", description: "PR number", required: true },
    { name: "focus", description: "Areas to focus on", required: false },
  ],
  handler: async (args) => {
    return {
      messages: [{
        role: "user",
        content: { type: "text", text: `Review PR #${args.pr_number}. ${args.focus ? `Focus on: ${args.focus}` : ""}` },
      }],
    };
  },
});
```

### Transport

Support both MCP transports:

1. **stdio** (primary): For local use with Claude Desktop, Cursor, etc.

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const transport = new StdioServerTransport();
await server.connect(transport);
```

2. **SSE** (optional): For remote access.

```typescript
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
// Expose on a configurable port (default: 50053)
```

### Configuration for MCP Clients

Users add Kraken to their MCP client config:

```json
// Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "kraken": {
      "command": "kraken",
      "args": ["mcp"],
      "env": {
        "KRAKEN_DAEMON_URL": "http://localhost:50051"
      }
    }
  }
}
```

```json
// Cursor: .cursor/mcp.json
{
  "mcpServers": {
    "kraken": {
      "command": "bunx",
      "args": ["@kraken/mcp-server"],
      "env": {}
    }
  }
}
```

### CLI Integration

Add `kraken mcp` subcommand to the Rust daemon CLI that starts the MCP server:

```rust
// In src/cli/mod.rs
Command::Mcp => {
    // Spawn the MCP server process (bun run apps/mcp-server/src/index.ts)
    // with stdio transport
}
```

## Implementation Steps

1. Create `apps/mcp-server/` with `package.json` depending on `@modelcontextprotocol/sdk`.
2. Implement `StdioServerTransport` entry point.
3. Add task management tools (schedule, list, get, cancel, retry) — these just proxy to daemon API.
4. Add search/analysis tools (conditionally available based on daemon capabilities).
5. Add resource providers (config, stats).
6. Add prompt templates.
7. Add `kraken mcp` CLI command.
8. Test with Claude Desktop and Cursor.
9. Publish to npm as `@kraken/mcp-server` for `bunx`/`npx` usage.

## Dependencies on Other Roadmap Items

- **Tree-sitter AST** (001): Enables `get_symbols` tool.
- **Code search index** (002): Enables `search_code` tool with indexed results.
- **Semantic search** (004): Enables `semantic_search` tool.
- **Dependency graph** (003): Enables `get_dependencies` tool.
- **Unified storage** (005): Session/message tools work best with unified storage.
- All dependencies are optional — tools are conditionally registered based on available daemon features.
