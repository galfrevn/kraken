# Tools

The agent interacts with the codebase and system through tools. Each tool is defined with a Zod schema for parameter validation and returns a structured result with a title, content, and optional metadata.

Tools are registered in `apps/app/src/tool/registry.ts` via `defineTool()` and resolved for the Vercel AI SDK at runtime.

## Implemented Tools

### `bash`

Execute a shell command and return its output.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | string | yes | The shell command to execute |
| `timeout` | number | no | Timeout in milliseconds (default: 120000) |

Runs commands via `bash -c`. Output is capped at 50,000 characters. Returns exit code in metadata.

**Source**: `apps/app/src/tool/bash.ts`

---

### `read`

Read the contents of a file with line numbers.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | Absolute or relative path to the file |
| `offset` | number | no | Line number to start reading from (1-indexed) |
| `limit` | number | no | Maximum number of lines to read |

Returns numbered lines. Supports pagination via offset/limit for large files. Returns total line count in metadata.

**Source**: `apps/app/src/tool/read.ts`

---

### `write`

Create or overwrite a file with the given content.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | Path to the file to create or overwrite |
| `content` | string | yes | The full file content to write |

Creates parent directories if they don't exist.

**Source**: `apps/app/src/tool/write.ts`

---

### `edit`

Edit a file by replacing an exact string match.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | Path to the file to edit |
| `oldString` | string | yes | The exact text to find (must be unique in the file) |
| `newString` | string | yes | The replacement text |

Fails if `oldString` is not found or matches more than once. Requires exact whitespace matching.

**Source**: `apps/app/src/tool/edit.ts`

---

### `glob`

Find files matching a glob pattern.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | Glob pattern (e.g., `**/*.ts`) |
| `path` | string | no | Directory to search in |

Uses Bun's built-in `Glob` API. Returns matching file paths. Capped at 200 results. Respects abort signals.

**Source**: `apps/app/src/tool/glob.ts`

---

### `grep`

Search file contents with a regex pattern.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | Regex pattern to search for |
| `path` | string | no | Directory to search in |
| `include` | string | no | File pattern filter (e.g., `*.ts`) |

Uses ripgrep (`rg`). Returns matching lines with file paths and line numbers.

**Source**: `apps/app/src/tool/grep.ts`

---

### `schedule_task`

Create a background task on the daemon for immediate execution by the next available worker.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | yes | Task description / prompt for the agent |
| `priority` | number | no | Priority 0-10 (lower = higher priority, default: 5) |
| `agent` | string | no | Agent to use: `build` (default) or `plan` |

Calls `POST /api/schedule` on the daemon. Returns the created task ID.

**Source**: `apps/app/src/tool/schedule.ts`

---

### `skill`

Load specialized instructions for a specific task from discovered SKILL.md files.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Name of the skill to load |

Skills are discovered from `~/.kraken/skills`, `./.kraken/skills`, and `packages/skills`. Each skill is a `SKILL.md` file with YAML frontmatter (`name`, `description`) and markdown body.

**Source**: `apps/app/src/tool/skill.ts`

---

### `webfetch`

Fetch content from a URL and return it in a readable format.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | The URL to fetch (must start with http:// or https://) |
| `format` | string | no | Output format: `markdown` (default), `text`, or `html` |
| `timeout` | number | no | Timeout in seconds (default: 30, max: 120) |

Uses Turndown to convert HTML to markdown. Retries with a plain user-agent on Cloudflare challenges. Response size capped at 5 MB.

**Source**: `apps/app/src/tool/webfetch.ts`

---

### `websearch`

Search the web for real-time information using the Tavily API.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | The search query |
| `numResults` | number | no | Number of results to return (default: 5, max: 10) |
| `includeAnswer` | boolean | no | Include an AI-generated answer summary (default: true) |

Requires `TAVILY_API_KEY` in `~/.kraken/.env`. Returns titles, URLs, and content snippets. Optionally includes an AI-generated answer.

**Source**: `apps/app/src/tool/websearch.ts`

---

## Security

All file-access tools (`bash`, `read`, `write`, `edit`) block access to sensitive paths (e.g., `~/.kraken/.env`, files matching `credentials`, `secrets`). This is enforced by `apps/app/src/tool/security.ts`.

---

## Planned Tools

These tools are planned to bring Kraken's tool set closer to modern agent standards (inspired by OpenCode).

### `task`

Spawn a subagent session for complex multi-step work.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | string | yes | Short description (3-5 words) |
| `prompt` | string | yes | Detailed task prompt |
| `subagent_type` | string | yes | Agent type to use |

### `multiedit`

Perform multiple sequential edits on a single file in one call.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | Path to the file |
| `edits` | array | yes | Array of `{oldString, newString}` pairs |

### `todowrite`

Write or update a task list for tracking progress within a session.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `todos` | array | yes | Array of `{id, content, status}` items |

### `todoread`

Read the current session's task list.

No parameters.

### `question`

Ask the user a structured question with predefined options.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `questions` | array | yes | Array of questions with options |

### `batch`

Execute multiple tool calls in parallel.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tool_calls` | array | yes | Array of `{tool, parameters}` objects |

### `lsp`

Perform Language Server Protocol operations for code intelligence.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `operation` | string | yes | LSP operation (goToDefinition, findReferences, hover, etc.) |
| `filePath` | string | yes | File path |
| `line` | number | yes | Line number (1-based) |
| `character` | number | yes | Character position (1-based) |

### `apply_patch`

Apply a multi-file unified patch (for models that work better with diffs).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `patchText` | string | yes | Full unified patch text |

---

## Adding a New Tool

1. Create a new file in `apps/app/src/tool/` (e.g., `webfetch.ts`)
2. Define the tool using `defineTool()`:

```typescript
import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";

export const webfetchTool = defineTool({
  id: "webfetch",
  description: "Fetch content from a URL.",
  parameters: z.object({
    url: z.string().describe("The URL to fetch"),
  }),
  async execute(args, context) {
    // implementation
    return {
      title: `Fetched ${args.url}`,
      content: responseBody,
    };
  },
});
```

3. Register it in `apps/app/src/tool/registry.ts`:

```typescript
import { webfetchTool } from "@/tool/webfetch.ts";

export function initializeBuiltinTools(): void {
  // ... existing tools
  registerTool(webfetchTool);
}
```

## Tool Interface

Every tool must implement `ToolDefinition`:

```typescript
interface ToolDefinition<TParameters extends z.ZodType> {
  id: string;
  description: string;
  parameters: TParameters;
  execute(args: z.infer<TParameters>, context: ToolContext): Promise<ToolResult>;
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
