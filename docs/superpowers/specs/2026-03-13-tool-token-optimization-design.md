# Tool Token Optimization Design

**Date:** 2026-03-13
**Status:** Approved

## Problem

The agent sends ~4,500 tokens of tool schemas with every LLM API request via the native `tools` array. In a 10-request conversation, that's ~45,000 tokens just for tool definitions. Many of these tools are irrelevant in the TUI chat context (scheduling, timers, task queue), and most descriptions are unnecessarily verbose.

## Strategy

Two independent optimizations, applied together:

1. **Trim tool descriptions** — reduce every tool description to a concise 1-liner
2. **Context-aware tool exclusion** — skip irrelevant tools based on entry point profile

## Strategy 1: Trim Tool Descriptions

### Principle

Each description should answer only: **what does this tool do?** Remove:
- Usage guidance ("Use this before...", "Useful for...")
- Internal implementation details ("Uses Brave Search API if... falls back to...")
- Cross-references to other tools ("For recurring tasks, use schedule_cron instead")
- Examples (parameter descriptions already cover format)
- Category lists that belong in parameter enums

### Trimmed Descriptions

| Tool | Original (chars) | Trimmed | Trimmed (chars) |
|---|---|---|---|
| read_file | 84 | Read file contents relative to working directory. | 48 |
| write_file | 110 | Write content to a file. Creates parent directories if needed. | 62 |
| edit_file | 327 | Replace an exact string in a file. old_string must be unique. | 61 |
| read_lines | 156 | Read a specific line range from a file (1-based). | 49 |
| delete_file | 157 | Delete a file or directory. | 27 |
| move_file | 149 | Move or rename a file or directory. | 36 |
| replace_in_files | 204 | Search and replace across files matching a glob pattern. | 55 |
| list_directory | 229 | List files and directories. Supports recursive depth 1-5. | 56 |
| search_files | 104 | Search for a text pattern in files using ripgrep. | 48 |
| glob_files | 202 | Find files matching a glob pattern. | 36 |
| code_outline | 217 | Extract structural outline (functions, classes, types) from a source file. | 73 |
| diff_files | 228 | Compare two files and show unified diff output. | 47 |
| git_status | 148 | Show branch, staged/unstaged changes, and untracked files. | 56 |
| git_diff | 147 | Show git diff. Defaults to unstaged changes. | 45 |
| git_commit | 154 | Stage files and create a git commit. | 37 |
| git_log | 89 | Show recent git commit history. | 31 |
| web_search | 274 | Search the web for information. | 31 |
| fetch_url | 192 | Fetch a URL and extract readable text. | 39 |
| http_request | 272 | Make an HTTP request to an external API. | 41 |
| run_command | 285 | Execute a shell command in the working directory. 30s timeout. | 61 |
| environment | 240 | Get system environment info: OS, runtime versions, memory, disk. | 63 |
| count_tokens | 217 | Estimate token count in a text string (~4 chars/token). | 53 |
| list_models | 197 | List available models from OpenRouter. | 38 |
| current_model | 233 | Get the current active LLM model. Read-only. | 44 |
| switch_model | 395 | Switch the active LLM model and persist to kraken.yml. | 54 |
| remember | 515 | Store a fact in persistent memory. Persists across sessions. | 59 |
| recall | 342 | Search persistent memory for stored facts. | 42 |
| index_project | 320 | Scan project structure and store in persistent memory. | 53 |
| task_list | 185 | List tasks in the agent queue. Filterable by status. | 51 |
| task_submit | 302 | Submit a new task to the agent queue for later execution. | 55 |
| schedule_cron | 341 | Schedule a recurring cron job. | 30 |
| list_schedules | 205 | List all scheduled cron jobs. | 29 |
| delete_schedule | 158 | Delete a scheduled cron job by ID. | 34 |
| schedule_watcher | 157 | Register a file watcher on directories. | 39 |
| delete_watcher | 60 | Delete a file watcher by ID. | 28 |
| schedule_once | 361 | Schedule a one-time task after a delay or at a specific time. | 60 |
| list_timers | 200 | List all pending one-time timers. | 32 |
| cancel_timer | 156 | Cancel a pending timer by ID. | 29 |
| view_image | 189 | View and analyze an image file. Returns metadata and encoded data. | 64 |
| ask_question | 426 | Ask the user questions with predefined options. | 47 |
| session_command | ~400 (dynamic) | Execute a session command. Commands: new, clear, delete, purge, rename, threads. | 80 |
| delegate | 301 | Delegate a task to a subagent with a clean context. | 51 |
| plugin_manager | ~550 | Manage plugins (list, install, configure, update, remove). | 56 |

### Estimated savings

- Before: ~9,000 chars in descriptions (~2,250 tokens)
- After: ~3,300 chars in descriptions (~825 tokens)
- **Savings: ~1,425 tokens per request**

### Parameter descriptions

Parameter descriptions are NOT trimmed. They are short already and necessary for the LLM to understand the schema.

## Strategy 2: Context-Aware Tool Exclusion

### Mechanism

Add a `profile` option to `ToolRegistryOptions` in `apps/core/src/tools/index.ts`:

```typescript
export interface ToolRegistryOptions {
  // ... existing fields ...
  profile?: "chat" | "daemon" | "cli";
}
```

### Profiles

**`"daemon"` (default):** All tools registered. Used by `apps/core/src/cli/commands.ts` `startCommand()`.

**`"chat"`:** Excludes tools irrelevant in interactive TUI:

| Excluded tools | Reason | Token savings (trimmed) |
|---|---|---|
| schedule_cron, list_schedules, delete_schedule, schedule_watcher, delete_watcher | No scheduler connected in TUI | ~160 |
| schedule_once, list_timers, cancel_timer | No timer manager in TUI | ~120 |
| task_list, task_submit | Task queue is for daemon, not chat | ~105 |
| count_tokens | Rarely useful interactively | ~53 |
| index_project | Can be triggered via recall/memory when needed | ~53 |

Total: 12 tools excluded, ~490 tokens saved per request.

**`"cli"`:** Same exclusions as chat. Used by `runCommand()`.

### Implementation

The registry already has conditional registration based on whether dependencies are provided (e.g., `schedulerClient`, `timerManager`, `taskQueueManager`). However, the TUI **does provide all these dependencies**, so the existing gates alone do not exclude anything. The profile adds a **second gate** inside each existing conditional block:

```typescript
// Scheduler tools: only register if client provided AND profile allows
if (options.schedulerClient) {
  if (profile !== "chat" && profile !== "cli") {
    registry.register(createScheduleCronTool(options.schedulerClient));
    // ...
  }
}

// Task tools: only register if queue provided AND profile allows
if (options.taskQueueManager) {
  if (profile !== "chat" && profile !== "cli") {
    registry.register(createTaskListTool(options.taskQueueManager));
    registry.register(createTaskSubmitTool(options.taskQueueManager));
  }
}

// index_project is already inside the database conditional block
if (options.database) {
  registry.register(createRememberTool(options.database));
  registry.register(createRecallTool(options.database));
  if (profile !== "chat" && profile !== "cli") {
    registry.register(createIndexProjectTool(options.database));
  }
}
```

For `count_tokens`, which is the only truly unconditional excluded tool:

```typescript
if (profile !== "chat" && profile !== "cli") {
  registry.register(countTokensTool);
}
```

### Entry point changes

| File | Function | Profile |
|---|---|---|
| `apps/tui/src/index.tsx` | main() | `"chat"` |
| `apps/core/src/cli/commands.ts` | runCommand() | `"cli"` |
| `apps/core/src/cli/commands.ts` | startCommand() | `"daemon"` (default) |

Note: `apps/tui/src/threads.ts` does NOT need changes — it receives the `toolRegistry` already constructed in `index.tsx`, so the profile is applied at registry creation time.

## Combined Impact

| Metric | Before | After (chat) | Savings |
|---|---|---|---|
| Number of tools (chat) | ~43 built-in | ~31 built-in | -12 tools |
| Description tokens | ~2,250 | ~660 | -1,590 |
| Total tool schema tokens | ~4,500 | ~2,100 | -2,400 (-53%) |
| 10-request conversation | ~45,000 | ~21,000 | -24,000 tokens |

## Files Modified

1. `apps/core/src/tools/reader.ts` — trim description
2. `apps/core/src/tools/writer.ts` — trim description
3. `apps/core/src/tools/editor.ts` — trim description
4. `apps/core/src/tools/filesystem.ts` — trim descriptions (4 tools)
5. `apps/core/src/tools/lister.ts` — trim description
6. `apps/core/src/tools/searcher.ts` — trim description
7. `apps/core/src/tools/globber.ts` — trim description
8. `apps/core/src/tools/outline.ts` — trim description
9. `apps/core/src/tools/diff.ts` — trim description
10. `apps/core/src/tools/git.ts` — trim descriptions (4 tools)
11. `apps/core/src/tools/executor.ts` — trim description
12. `apps/core/src/tools/browser.ts` — trim descriptions (2 tools)
13. `apps/core/src/tools/http.ts` — trim description
14. `apps/core/src/tools/environment.ts` — trim description
15. `apps/core/src/tools/tokens.ts` — trim description
16. `apps/core/src/tools/model.ts` — trim descriptions (3 tools)
17. `apps/core/src/tools/memory.ts` — trim descriptions (3 tools)
18. `apps/core/src/tools/tasks.ts` — trim descriptions (2 tools)
19. `apps/core/src/tools/scheduler.ts` — trim descriptions (5 tools)
20. `apps/core/src/tools/timers.ts` — trim descriptions (3 tools)
21. `apps/core/src/tools/vision.ts` — trim description
22. `apps/core/src/tools/question.ts` — trim description
23. `apps/core/src/tools/session.ts` — trim description
24. `apps/core/src/tools/delegate.ts` — trim description
25. `apps/core/src/tools/plugins.ts` — trim description
26. `apps/core/src/tools/index.ts` — add profile to ToolRegistryOptions, gate tools by profile
27. `apps/tui/src/index.tsx` — pass profile: "chat"
28. `apps/core/src/cli/commands.ts` — pass profile: "cli" / "daemon"

## Not Changed

- Parameter descriptions (already concise)
- Plugin-registered tools (plugins manage their own descriptions)
- Tool execution logic (no behavioral changes)
- System prompt (doesn't include tool descriptions, but does reference some tool names in guidance text — e.g., "use edit_file instead of write_file". These references remain even if tools are excluded by profile. This is harmless: the LLM will simply not have those tools available and will ignore the guidance. A future follow-up could make the system prompt profile-aware.)
