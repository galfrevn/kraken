# 025 — TodoWrite Tool

## Summary

A built-in tool that allows the LLM to create, update, and track task lists during complex multi-step operations. Renders as a persistent task list in the TUI sidebar or as inline status blocks.

## Motivation

During complex tasks (refactoring across many files, implementing multi-step features), the agent needs to:

- Plan work before starting
- Track what's been done and what remains
- Show the user clear progress
- Avoid losing track of steps when the context window is large

OpenCode implements `todowrite` as a tool that the LLM calls to create/update a todo list. The TUI renders it visually. This gives both the agent and the user a shared view of progress.

## Architecture

### Tool Definition

File: `apps/app/src/tool/todo.ts`

```typescript
parameters: z.object({
  todos: z.array(z.object({
    id: z.string().describe("Unique identifier for this todo item"),
    content: z.string().describe("Description of the task"),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  })).min(1),
  merge: z.boolean().describe("If true, merge with existing todos by id. If false, replace all."),
})
```

### TodoStore

In-memory store keyed by sessionId. Persisted as long as the session is active.

```typescript
// apps/app/src/tool/todo.ts
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  updatedAt: number;
}

const sessionTodos = new Map<string, TodoItem[]>();
```

### Merge Behavior

When `merge: true`:
- Match incoming todos with existing ones by `id`
- Update matched todos (status, content)
- Add new todos that don't match any existing id
- Existing todos not in the incoming list remain unchanged

When `merge: false`:
- Replace the entire todo list with the incoming list

### Bus Events

```
todo.updated → { sessionId, todos: TodoItem[] }
```

Published after every tool call so the TUI can update in real-time.

### Tool Return Value

Returns the current state of the full todo list as confirmation, so the LLM sees what the user sees.

### TUI Component

File: `apps/app/src/tui/session/_components/todo.tsx`

Renders inline in the message stream when todos are active:

```
┌─ Tasks ──────────────────────────────┐
│ ✓ Add parent_id to session schema    │
│ ✓ Update Session module              │
│ ◉ Extend AgentDefinition             │
│ ○ Create subagent tool               │
│ ○ Register + update prompts          │
│ ✗ Calendar integration (cancelled)   │
└──────────────────────────────────────┘
```

Status icons:
- `○` pending
- `◉` in_progress (with agent color)
- `✓` completed (green)
- `✗` cancelled (muted)

The component shows:
- Total count and completion percentage in the header
- Each todo with its status icon and content
- The list collapses completed items after a threshold (e.g., >5 completed → show count)

### System Prompt Integration

The current todo state is injected into the system prompt context when todos exist for the session, so the LLM always has visibility:

```
# Current Tasks (3/7 completed)
- [completed] Add parent_id to session schema
- [completed] Update Session module
- [in_progress] Extend AgentDefinition
- [pending] Create subagent tool
```

This ensures the LLM doesn't lose track even after context window management truncates older messages.

### SSE Forwarding

Todo events are forwarded via SSE so the TUI updates in real-time as the LLM creates/updates todos during streaming.

### Interaction with Sub-agents

Disabled for sub-agents by default (via toolFilter). Sub-agents should focus on their task, not manage parent todo lists.

## Files to Create/Modify

| File | Action |
|------|--------|
| `apps/app/src/tool/todo.ts` | **Create** — tool definition, TodoStore, merge logic |
| `apps/app/src/tool/registry.ts` | **Modify** — register todo tool |
| `apps/app/src/bus/index.ts` | **Modify** — add Todo events |
| `apps/app/src/server/routes/event.ts` | **Modify** — forward todo events via SSE |
| `apps/app/src/tui/session/_components/todo.tsx` | **Create** — todo list rendering component |
| `apps/app/src/tui/session/index.tsx` | **Modify** — listen for todo events, render TodoDisplay |
| `apps/app/src/agent/prompt.ts` | **Modify** — inject current todos into system prompt |

## Configuration

No additional configuration needed. The tool is available by default for primary agents and excluded from sub-agents via their existing `toolFilter`.

## Dependencies

- None — standalone feature
- Complements 024-question-tool for a complete agent interaction system
