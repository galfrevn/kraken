# Custom Tool Plugin System

## Summary

Allow users to define custom tools as TypeScript files in `~/.kraken/tools/` (global) or `.kraken/tools/` (per-project). Tools are auto-discovered and registered alongside built-in tools, using the same `defineTool` API. This extends the agent's capabilities without modifying Kraken's source code.

## Motivation

Every project has unique needs: deploying to a specific platform, interacting with a proprietary API, running a custom linter, querying a specific database. Today users must either use the generic `bash` tool (which requires the agent to construct commands) or modify Kraken's source. A plugin system lets users create purpose-built tools.

## Current State

- `apps/app/src/tool/tool.ts` defines `ToolDefinition` with `id`, `description`, `parameters` (Zod), `execute`.
- `apps/app/src/tool/registry.ts` has `registerTool()` and `initializeBuiltinTools()`.
- Skills are auto-discovered from `~/.kraken/skills/` — similar discovery can be used for tools.
- No plugin system exists for tools.

## Architecture

### Plugin Directory Structure

```
~/.kraken/tools/             # global tools
  deploy-vercel/
    tool.ts                  # tool definition
    README.md                # optional documentation
  query-postgres/
    tool.ts
    helpers.ts               # companion files
    package.json             # optional dependencies

.kraken/tools/               # project-specific tools
  run-migrations/
    tool.ts
```

### Plugin Tool Definition

Users write standard TypeScript files using a simplified API:

```typescript
// ~/.kraken/tools/deploy-vercel/tool.ts
import { z } from "zod";

export default {
  id: "deploy_vercel",
  description: "Deploy the current project to Vercel. Runs build, deploys, and returns the deployment URL.",
  parameters: z.object({
    environment: z.enum(["preview", "production"]).default("preview").describe("Deployment environment"),
    skipBuild: z.boolean().default(false).describe("Skip the build step"),
  }),
  execute: async (args: { environment: string; skipBuild: boolean }, context: { workingDirectory: string }) => {
    const flags = [
      args.environment === "production" ? "--prod" : "",
      args.skipBuild ? "--skip-domain-wait" : "",
    ].filter(Boolean).join(" ");

    const proc = Bun.spawn(["vercel", "deploy", ...flags.split(" ")], {
      cwd: context.workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    return {
      title: `Deploy to Vercel (${args.environment})`,
      content: exitCode === 0
        ? `Deployed successfully.\n\n${stdout}`
        : `Deployment failed (exit ${exitCode}).\n\n${stdout}`,
    };
  },
};
```

### Discovery & Loading

Add `apps/app/src/tool/plugins.ts`:

```typescript
import { join } from "path";
import { readdirSync, existsSync } from "fs";
import { registerTool } from "./registry";
import type { ToolDefinition } from "./tool";

const TOOL_DIRECTORIES = [
  join(process.env.HOME ?? ".", ".kraken", "tools"),
  join(process.cwd(), ".kraken", "tools"),
];

export async function discoverAndRegisterPluginTools(): Promise<void> {
  const loadedIds = new Set<string>();

  for (const directory of TOOL_DIRECTORIES) {
    if (!existsSync(directory)) continue;

    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const toolFile = join(directory, entry.name, "tool.ts");
      if (!existsSync(toolFile)) continue;

      try {
        const module = await import(toolFile);
        const toolDef: ToolDefinition = module.default;

        if (!toolDef.id || !toolDef.execute) {
          console.warn(`[plugins] Invalid tool in ${toolFile}: missing id or execute`);
          continue;
        }

        // Prevent overriding built-in tools
        if (isBuiltinTool(toolDef.id)) {
          console.warn(`[plugins] Tool '${toolDef.id}' conflicts with a built-in tool, skipping`);
          continue;
        }

        // Deduplicate (project tools take precedence over global)
        if (loadedIds.has(toolDef.id)) continue;
        loadedIds.add(toolDef.id);

        registerTool(toolDef);
        console.log(`[plugins] Loaded tool: ${toolDef.id} from ${toolFile}`);
      } catch (error) {
        console.warn(`[plugins] Failed to load ${toolFile}: ${error}`);
      }
    }
  }
}

function isBuiltinTool(id: string): boolean {
  return ["bash", "read", "write", "edit", "glob", "grep", "schedule_task", "skill"].includes(id);
}
```

### Registration in Startup

Modify `apps/app/src/tool/registry.ts`:

```typescript
import { discoverAndRegisterPluginTools } from "./plugins";

export async function initializeAllTools(): Promise<void> {
  initializeBuiltinTools();
  await discoverAndRegisterPluginTools();
}
```

### System Prompt Integration

Plugin tools are automatically included in the system prompt since `getRegisteredToolIds()` returns all registered tools (built-in + plugins). The `description` field of each plugin tool is included in the prompt.

### Plugin Dependencies

If a plugin has a `package.json`, install dependencies on first load:

```typescript
const packageJsonPath = join(directory, entry.name, "package.json");
if (existsSync(packageJsonPath)) {
  const nodeModules = join(directory, entry.name, "node_modules");
  if (!existsSync(nodeModules)) {
    console.log(`[plugins] Installing dependencies for ${entry.name}...`);
    await Bun.spawn(["bun", "install"], {
      cwd: join(directory, entry.name),
    }).exited;
  }
}
```

### Plugin Scaffold Command

```bash
kraken tool create my-tool              # scaffold a new tool
kraken tool list                        # list all tools (built-in + plugins)
kraken tool validate ~/.kraken/tools/x  # validate a plugin tool
```

Scaffold creates:

```typescript
// ~/.kraken/tools/my-tool/tool.ts
import { z } from "zod";

export default {
  id: "my_tool",
  description: "Description of what this tool does",
  parameters: z.object({
    // define parameters here
  }),
  execute: async (args, context) => {
    // implement tool logic here
    return {
      title: "My Tool",
      content: "Tool result",
    };
  },
};
```

### Security Considerations

- Plugin tools run with the same permissions as the app process. The sandbox (roadmap 017) should apply to plugin tool execution.
- Plugin tools are loaded via `import()` — they can execute arbitrary code at import time. Users should only install trusted plugins.
- Consider a `--no-plugins` flag to disable plugin loading for security-sensitive environments.

### Plugin Examples

| Plugin | Description |
|--------|-------------|
| `deploy-vercel` | Deploy to Vercel |
| `query-postgres` | Run SQL queries against a Postgres database |
| `run-migrations` | Run database migrations (Drizzle, Prisma, etc.) |
| `notify-team` | Send a message to a specific Slack channel |
| `create-jira-ticket` | Create a Jira ticket from a description |
| `screenshot-url` | Take a screenshot of a URL using Playwright |
| `lint-custom` | Run a project-specific linter with custom rules |

## Configuration

```jsonc
{
  "plugins": {
    "enabled": true,
    "directories": [
      "~/.kraken/tools",
      ".kraken/tools"
    ],
    "autoInstallDependencies": true,
    "blocklist": []                    // plugin IDs to skip loading
  }
}
```

## Dependencies on Other Roadmap Items

- **Sandboxing** (017): Plugin tool execution should respect sandbox settings.
- **Audit log** (016): Plugin tool calls should be audit-logged like built-in tools.
- **MCP server** (008): Plugin tools should be optionally exposed via the MCP server.
