# 024 — Question Tool

## Summary

A built-in tool that allows the LLM to ask the user structured questions during execution, with selectable options and free-text input. Renders as an interactive prompt in the TUI.

## Motivation

Currently, the only way for the agent to gather clarification is by producing text and waiting for the user to type a response. This creates friction:

- The agent cannot present structured choices (e.g., "Which approach do you prefer? A, B, or C")
- The user must read, understand, and type a response even for simple yes/no decisions
- There's no way to distinguish a question from regular output visually
- In Plan mode, the agent needs to gather requirements before proposing a plan — structured questions make this flow natural

OpenCode implements this as a `question` tool with a dedicated `QuestionPrompt` TUI component. We adapt the same pattern.

## Architecture

### Tool Definition

File: `apps/app/src/tool/question.ts`

```typescript
parameters: z.object({
  questions: z.array(z.object({
    id: z.string().describe("Unique identifier for this question"),
    text: z.string().describe("The question to ask the user"),
    options: z.array(z.object({
      value: z.string(),
      label: z.string().max(60),
    })).min(2).describe("Available options"),
    allowMultiple: z.boolean().optional().describe("Allow selecting multiple options"),
  })).min(1).max(5),
})
```

### Ask/Reply Mechanism

The tool creates a `Promise` that blocks execution until the user answers:

```
LLM calls question tool
  → tool creates Promise + stores resolver in QuestionStore
  → publishes Bus event "question.asked"
  → TUI renders QuestionPrompt overlay
  → user selects options / types custom answer
  → TUI calls POST /session/:id/question/reply
  → route resolves the stored Promise
  → tool returns answers to LLM
```

### QuestionStore

In-memory store keyed by sessionId. Only one pending question per session at a time.

```typescript
// apps/app/src/tool/question.ts
interface PendingQuestion {
  questions: Array<{ id: string; text: string; options: Array<{ value: string; label: string }>; allowMultiple?: boolean }>;
  resolve: (answers: Record<string, string[]>) => void;
}

const pendingQuestions = new Map<string, PendingQuestion>();
```

### Bus Events

```
question.asked  → { sessionId, questions }
question.replied → { sessionId, answers }
```

### HTTP Routes

```
POST /session/:id/question/reply
  body: { answers: Record<string, string[]> }
  → resolves the pending promise
```

### TUI Component

File: `apps/app/src/tui/session/_components/question.tsx`

Renders when a `question.asked` event is received:

- Shows each question with numbered options
- Arrow keys / j/k to navigate options
- Enter to select (single) or Space to toggle + Enter to confirm (multiple)
- Esc to dismiss (sends empty answers, agent proceeds with best judgment)
- Left/Right or h/l to switch between questions when there are multiple
- Uses the current agent color for the border/highlight
- Replaces the prompt input while active

### Worker/Headless Filtering

The question tool is automatically excluded from the tool list when:
- Running in headless worker mode (`apps/app/src/worker.ts`)
- The agent's `toolFilter` excludes it (sub-agents should NOT have access)

When filtered out, the LLM simply cannot call it.

### System Prompt Hint

```
question: "Ask the user structured questions with selectable options. Use sparingly — only when you genuinely need user input to proceed. Do NOT re-ask what the user already told you."
```

The "use sparingly" instruction is critical — OpenCode's #1 complaint is over-eager use.

## Files to Create/Modify

| File | Action |
|------|--------|
| `apps/app/src/tool/question.ts` | **Create** — tool definition, PendingQuestion store, ask/reply |
| `apps/app/src/tool/registry.ts` | **Modify** — register question tool (only in TUI mode) |
| `apps/app/src/bus/index.ts` | **Modify** — add Question events |
| `apps/app/src/server/routes/session.ts` | **Modify** — add `/question/reply` route |
| `apps/app/src/server/routes/event.ts` | **Modify** — forward question events via SSE |
| `apps/app/src/tui/session/_components/question.tsx` | **Create** — interactive question prompt component |
| `apps/app/src/tui/session/index.tsx` | **Modify** — listen for question events, render QuestionPrompt |
| `apps/app/src/agent/prompt.ts` | **Modify** — add question tool hint |
| `apps/app/src/worker.ts` | **Modify** — exclude question tool from worker |

## Configuration

```jsonc
// kraken.jsonc
{
  "agents": {
    "build": {
      // question tool enabled by default for primary agents
    },
    "explore": {
      // question tool disabled for sub-agents (already excluded by toolFilter)
    }
  }
}
```

## Dependencies

- None — standalone feature
- Should be implemented before or alongside 025-todowrite for a complete agent interaction system
