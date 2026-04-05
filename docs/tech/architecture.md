# Architecture

Kraken is a two-process system: a Rust daemon and a TypeScript app communicating over HTTP REST on localhost.

```
┌──────────────────────────────────────────────────────┐
│                      CLI (Rust)                      │
│              kraken start / kraken daemon             │
├──────────────────────┬───────────────────────────────┤
│     Daemon (Rust)    │         App (TypeScript)      │
│     Port 50051       │         Port 7899             │
│                      │                               │
│  • Orchestrator      │  • Agent brain (LLM loop)     │
│  • Cron engine       │  • Tool registry              │
│  • File watchers     │  • Session management         │
│  • Webhook server    │  • TUI (OpenTUI/React)        │
│  • Trigger engine    │  • MCP client                 │
│  • Task store        │  • Storage (SQLite/Drizzle)   │
│  • Notifications     │  • Model registry             │
│  • HTTP API          │  • Skill system               │
└──────────┬───────────┴───────────────┬───────────────┘
           │    HTTP REST (localhost)   │
           └───────────────────────────┘
                       │
            ┌──────────┴──────────┐
            │   Channel Workers   │
            │  (Telegram, Discord)│
            └─────────────────────┘
```

---

## Daemon (Rust)

The daemon is a single binary built with tokio. It manages:

- **Orchestrator** — Polls the task store every second, spawns workers up to the concurrency limit, monitors heartbeats, handles retries, manages git worktrees
- **Trigger engine** — Matches events (cron, webhooks, file changes) against configured triggers and creates tasks with template variable substitution
- **Cron engine** — Registers cron expressions, ticks on schedule, emits events via tokio broadcast
- **File watcher** — OS-native file system notifications via `notify` with configurable debounce
- **Webhook server** — Separate port (default 50052), validates GitHub (HMAC-SHA256) and GitLab webhooks
- **HTTP API** — Axum-based REST API for task management, health, config, secrets, and stats
- **Notification dispatcher** — Routes task lifecycle events to Slack, Discord, Email, GitHub, or system notifications
- **Task store** — SQLite database with status transitions, retry tracking, and cost aggregation

---

## App (TypeScript)

A Bun-based application with a React terminal UI:

- **Agent brain** — Vercel AI SDK with `streamText` driving the LLM loop. Supports OpenRouter, Anthropic, OpenAI
- **Tool registry** — Tools defined with Zod schemas via `defineTool()`, each receiving a `ToolContext`
- **MCP client** — Connects to MCP servers (stdio and HTTP/SSE). Tools merged with built-in tools
- **Session management** — SQLite via Drizzle ORM, event bus for reactive UI
- **TUI** — OpenTUI (`@opentui/react`), 60 FPS rendering, syntax highlighting, streaming responses
- **Context management** — Automatic token estimation, tool result truncation, extractive summarization for long conversations

---

## Workers

Workers are headless agent instances without the TUI. The orchestrator spawns them as child processes:

```
bun run worker.js --task-id=<uuid> --daemon-url=http://localhost:50051
```

Each worker gets its own git worktree for isolation. Workers send heartbeats every 30 seconds and report usage and output on completion. Workers that stop heartbeating are killed after the configured timeout.

---

## Storage

| Store | Technology | Location |
| --- | --- | --- |
| Task database | SQLite (rusqlite) | Configured in `kraken.jsonc` |
| Session database | SQLite (Drizzle) | `~/.kraken/data/kraken.db` |
| Configuration | JSONC | `~/.kraken/kraken.jsonc` |
| API keys | dotenv | `~/.kraken/.env` |

---

## Directory structure

```
apps/
  app/                TypeScript — TUI, agent brain, tools, sessions
    src/
      agent/          Agent definitions and system prompt
      config/         Configuration loading
      mcp/            MCP client (stdio, HTTP, SSE)
      provider/       LLM provider integration
      session/        Session persistence, context window
      skill/          Skill discovery and loading
      tool/           Tool implementations and registry
      tui/            Terminal UI components
  daemon/             Rust — Daemon
    src/
      cli/            CLI commands (clap)
      cron.rs         Cron scheduling
      daemon/         State, config, reload
      db/             SQLite task store
      http_api.rs     REST API (axum)
      notifications/  Notification channels
      orchestrator/   Workers, heartbeat, worktrees
      triggers/       Trigger engine, webhook, cron, watcher
packages/
  sdk/                TypeScript SDK for daemon interaction
  skills/             Skill definitions (SKILL.md files)
  configuration/      Shared TypeScript config
  visuals/            Remotion visuals
```
