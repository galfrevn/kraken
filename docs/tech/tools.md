# Tools

The agent interacts with the codebase through tools. Each tool is defined with a Zod schema for parameter validation and returns a structured result.

---

## Built-in tools

| Tool | Description |
| --- | --- |
| `bash` | Execute shell commands (timeout configurable, output capped at 50K chars) |
| `read` | Read file contents with line numbers, pagination via offset/limit |
| `write` | Create or overwrite files, creates parent directories |
| `edit` | Replace exact string matches in files (must be unique) |
| `glob` | Find files by glob pattern (capped at 200 results) |
| `grep` | Search file contents with regex via ripgrep |
| `security` | Analyze code for vulnerabilities and secrets |
| `schedule_task` | Create background tasks on the daemon |
| `skill` | Load specialized instructions from SKILL.md files |
| `webfetch` | Fetch URLs as markdown, text, or HTML (5 MB limit) |
| `websearch` | Search the web via Tavily API |
| `subagent` | Delegate to specialized sub-agents (explore, general) |
| `question` | Ask the user structured questions with options |
| `todowrite` | Create and manage task lists within a session |
| `channel_send` | Send messages to Telegram or Discord |
| `memory_save` | Save observations to persistent memory |
| `memory_search` | Search persistent memory |
| `memory_context` | Load recent memory for current project |
| `task_list` | List daemon tasks with status filtering |
| `task_get` | Get task details and output |
| `task_delete` | Delete pending or cancelled tasks |
| `github_pr_list` | List pull requests |
| `github_pr_get` | Get PR details |
| `github_pr_create` | Create a pull request |
| `github_pr_comment` | Comment on a PR or issue |
| `github_pr_merge` | Merge a pull request |
| `github_issue_list` | List issues |
| `github_issue_create` | Create an issue |

All file-access tools block access to sensitive paths (`~/.kraken/.env`, credentials, secrets) via `security.ts`.

---

## Adding a tool

1. Create `apps/app/src/tool/<name>.ts`
2. Define with `defineTool()`:

```typescript
import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";

export const myTool = defineTool({
  id: "my_tool",
  description: "What this tool does.",
  parameters: z.object({
    input: z.string().describe("The input"),
  }),
  async execute(args, context) {
    return {
      title: `Result for ${args.input}`,
      content: "...",
    };
  },
});
```

3. Register in `apps/app/src/tool/registry.ts`:

```typescript
import { myTool } from "@/tool/my-tool.ts";

export function initializeBuiltinTools(): void {
  // ...existing tools
  registerTool(myTool);
}
```

---

## Tool interface

```typescript
interface ToolDefinition<T extends z.ZodType> {
  id: string;
  description: string;
  parameters: T;
  execute(args: z.infer<T>, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  sessionId: string;
  messageId: string;
  workingDirectory: string;
  abortSignal: AbortSignal;
}

interface ToolResult {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}
```
