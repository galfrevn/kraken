# Sub-Agents & Per-Agent Model Routing

## Summary

Replace the single-model-per-session architecture with a sub-agent system where each agent can have its own model. The primary agent delegates tasks to specialized sub-agents (explore, general) that run in child sessions with their own model, tool permissions, and conversation history. Inspired by OpenCode's agent architecture.

## Motivation

Using Claude Sonnet for every step — including simple file reads and codebase exploration — wastes cost and time. Instead of auto-routing by complexity (fragile heuristics, no agent does this successfully), we follow OpenCode's proven approach: let the LLM decide when to delegate to a cheaper sub-agent via a `subagent` tool.

Benefits:
- **Cost savings** — `explore` sub-agent uses a fast/cheap model (Haiku) for read-only tasks
- **Predictable** — each agent always uses its configured model, no heuristic surprises
- **Configurable** — users control which model each agent uses via `kraken.jsonc`
- **Isolated** — sub-agents run in child sessions with restricted permissions
- **Resumable** — sub-agent sessions can be continued with a `task_id`

## Current State

- `apps/app/src/agent/agent.ts`: `AgentDefinition` has `id`, `name`, `description`, `mode` ("primary" | "subagent"), `systemPrompt`, `toolFilter`. Two built-in agents: `build` (full access) and `plan` (read-only). No `model` field per agent.
- `apps/app/src/provider/index.ts`: `resolveLanguageModel()` returns a single model from config. No per-agent model support.
- `apps/app/src/session/llm.ts`: `streamLlm()` calls `resolveLanguageModel()` once. No `experimental_prepareStep`.
- `apps/app/src/session/index.ts`: `Session.create(agentId?, model?)`. No `parentId` for child sessions.
- `apps/app/src/storage/schema.ts`: `sessionTable` has no `parentId` column.
- `apps/app/src/config/index.ts`: Config has `provider` and `model` as single strings. No `agent` section, no `small_model`.
- `apps/app/src/tool/task.ts`: `task_list`, `task_get`, `task_delete` — these interact with daemon tasks, NOT sub-agents.

## Architecture

### Agent Definitions

Extend `AgentDefinition` in `apps/app/src/agent/agent.ts`:

```typescript
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  mode: "primary" | "subagent" | "internal";
  systemPrompt: string;
  toolFilter?: (toolId: string) => boolean;
  model?: { provider: string; model: string };
  maxSteps?: number;
}
```

Built-in agents:

| Agent | Mode | Tools | Default Model | Purpose |
|-------|------|-------|---------------|---------|
| `build` | primary | all | config default | Full-access development |
| `plan` | primary | read-only | config default | Read-only analysis |
| `explore` | subagent | read, glob, grep, bash (read-only), webfetch, websearch | fast (Haiku) | Quick codebase exploration |
| `general` | subagent | all except `subagent` | config default | Multi-step research and execution |
| `title` | internal | none | small model | Session title generation |

### Sub-Agent Tool

New tool `subagent` in `apps/app/src/tool/subagent.ts`:

```typescript
export const subagentTool = defineTool({
  id: "subagent",
  description: "...", // Dynamic: includes available sub-agents
  parameters: z.object({
    description: z.string().describe("A short (3-5 words) description of the task"),
    prompt: z.string().describe("The task for the agent to perform"),
    subagent_type: z.string().describe("Agent to use: 'explore' or 'general'"),
    task_id: z.string().optional().describe("Resume a previous sub-agent session"),
  }),
  async execute(args, context) {
    const agent = getAgent(args.subagent_type);
    // 1. Create or resume child session
    // 2. Resolve model (agent.model ?? parent model)
    // 3. Run processUserMessage in child session
    // 4. Extract final text, return wrapped in <subagent_response>
    // 5. Return task_id for potential resumption
  },
});
```

Flow:

```
User prompt → build agent (Sonnet)
  ├─ reads files, understands task
  ├─ calls subagent({ type: "explore", prompt: "find all API routes" })
  │   └─ explore agent (Haiku) → reads, greps, returns findings
  ├─ synthesizes findings
  ├─ calls subagent({ type: "general", prompt: "refactor the auth module" })
  │   └─ general agent (Sonnet) → reads, writes, edits, returns result
  └─ returns final response to user
```

### Child Sessions

Add `parentId` to session schema:

```sql
ALTER TABLE session ADD COLUMN parent_id TEXT REFERENCES session(id) ON DELETE CASCADE;
```

`Session.create` accepts `parentId`:

```typescript
Session.create({
  agentId: "explore",
  model: "anthropic/claude-haiku-3.5",
  parentId: parentSessionId,
  title: "Explore: find API routes (@explore subagent)",
})
```

Child sessions:
- Have their own message history (isolated context)
- Link to parent via `parentId`
- Are excluded from the session list in the TUI (filtered by `parentId IS NULL`)
- Can be resumed by passing `task_id` to the `subagent` tool

### Per-Agent Model Configuration

Extend `kraken.jsonc`:

```jsonc
{
  "languageModel": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4-20250514",
    "small_model": "anthropic/claude-haiku-3.5"
  },
  "agent": {
    "explore": {
      "model": "anthropic/claude-haiku-3.5"
    },
    "general": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "build": {
      "prompt": "Additional instructions for build agent..."
    }
  }
}
```

Config schema addition in `apps/app/src/config/index.ts`:

```typescript
const agentConfigSchema = z.object({
  model: z.string().optional(),          // "provider/model" format
  prompt: z.string().optional(),         // additional system prompt
  disabled: z.boolean().optional(),      // disable this agent
  maxSteps: z.number().optional(),       // override maxSteps
});

const configSchema = z.object({
  // ...existing fields...
  smallModel: z.string().optional(),
  agents: z.record(z.string(), agentConfigSchema).optional(),
});
```

### Model Resolution

Modify `apps/app/src/provider/index.ts`:

```typescript
export function resolveLanguageModel(override?: { provider: string; model: string }): LanguageModelV1 {
  const config = loadConfig();
  const provider = override?.provider ?? config.provider;
  const model = override?.model ?? config.model;
  // ...resolve and cache...
}

export function resolveSmallModel(): LanguageModelV1 {
  const config = loadConfig();
  const smallModelId = config.smallModel ?? "anthropic/claude-haiku-3.5";
  const [provider, ...modelParts] = smallModelId.split("/");
  return resolveLanguageModel({ provider: provider!, model: modelParts.join("/") });
}
```

In `streamLlm`, accept an optional model override:

```typescript
export async function streamLlm(options: StreamLlmOptions) {
  const agent = getAgent(options.agentId);
  const languageModel = agent?.model
    ? resolveLanguageModel(agent.model)
    : resolveLanguageModel();
  // ...rest unchanged...
}
```

### Sub-Agent Execution

The `subagent` tool runs the child agent in-process (not via daemon). It:

1. Creates/resumes a child session with `Session.create({ parentId, agentId })`
2. Resolves the agent's model (agent config > parent model)
3. Calls `processUserMessage()` on the child session
4. Waits for the stream to complete
5. Extracts the final assistant text from the child session
6. Returns it wrapped in `<subagent_response>` tags with the `task_id`

The child session's `processUserMessage` uses the same `streamLlm` pipeline, but with the sub-agent's model and tool set.

Abort propagation: the parent's abort signal cancels the child session.

### Agent Loading from Markdown Files

Support user-defined agents via `.kraken/agents/` directory (like OpenCode):

```
~/.kraken/agents/
  reviewer.md
  tester.md
```

Each file has YAML frontmatter:

```markdown
---
mode: subagent
model: anthropic/claude-haiku-3.5
description: Reviews code changes for bugs and style issues
tools:
  - read
  - glob
  - grep
  - bash
---

You are a code reviewer. Analyze the provided code changes and identify:
- Potential bugs
- Style inconsistencies
- Performance issues
- Security concerns

Be thorough but concise. Focus on actionable feedback.
```

These are loaded by `initializeAgents()` and merged with built-in agents (user config overrides built-in).

### TUI Changes

1. **Agent switching** — `Tab` key cycles between primary agents (build, plan). Show current agent in the prompt label.
2. **Session list** — Filter child sessions (`parentId IS NULL`) from the session picker.
3. **Agent picker** — `Ctrl+A` opens an agent picker dialog (like the model picker).

## Files to Create

| File | Purpose |
|------|---------|
| `apps/app/src/tool/subagent.ts` | Sub-agent invocation tool |

## Files to Modify

| File | Changes |
|------|---------|
| `apps/app/src/agent/agent.ts` | Add `model`, `maxSteps` to `AgentDefinition`. Add `explore`, `general`, `title` agents. Load from `~/.kraken/agents/`. |
| `apps/app/src/provider/index.ts` | `resolveLanguageModel(override?)` + `resolveSmallModel()` |
| `apps/app/src/session/llm.ts` | Use agent's model when available |
| `apps/app/src/session/index.ts` | `Session.create({ parentId })` + `Session.children()` |
| `apps/app/src/storage/schema.ts` | Add `parentId` column to `sessionTable` |
| `apps/app/src/storage/db.ts` | Migration for `parent_id` column |
| `apps/app/src/config/index.ts` | Add `smallModel`, `agents` to config schema. Parse from `kraken.jsonc`. |
| `apps/app/src/tool/registry.ts` | Register `subagentTool` |
| `apps/app/src/agent/prompt.ts` | Include available sub-agents in system prompt `TOOL_HINTS` |
| `apps/app/src/server/routes/session.ts` | Filter child sessions from list endpoint |
| `apps/app/src/tui/session/index.tsx` | Agent switching via Tab, show agent name |
| `apps/app/src/tui/session/_components/prompt.tsx` | Show current agent label |
| `apps/app/src/tui/session/_components/sidebar.tsx` | Show current agent |

## Configuration

```jsonc
{
  "languageModel": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4-20250514",
    "small_model": "anthropic/claude-haiku-3.5"
  },
  "agent": {
    "explore": {
      "model": "anthropic/claude-haiku-3.5",
      "description": "Fast codebase exploration"
    },
    "general": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "build": {
      "prompt": "You prefer functional programming patterns."
    },
    "custom_reviewer": {
      "model": "anthropic/claude-haiku-3.5",
      "mode": "subagent",
      "description": "Code review specialist",
      "prompt": "You are a code reviewer...",
      "tools": ["read", "glob", "grep"]
    }
  }
}
```

## Dependencies on Other Roadmap Items

- **Tool Result Caching** (014 - done): Sub-agents benefit from cached reads, reducing redundant disk I/O.
- **Streaming Improvements** (019 - done): Sub-agent progress should be visible in the TUI.
- **Cost tracking** (015 - telemetry): Multi-model usage makes per-model cost tracking more valuable.
