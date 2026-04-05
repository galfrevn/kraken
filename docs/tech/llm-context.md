# LLM Context

Condensed reference for AI agents working on the Kraken codebase.

---

## What is Kraken

Autonomous developer agent. Rust daemon (scheduling, triggers, orchestration, notifications) + TypeScript app (LLM loop, tools, TUI). The daemon reacts to cron, file changes, and webhooks to execute tasks autonomously. The TUI is optional.

---

## Tech stack

- **Monorepo**: Bun workspaces + Turborepo
- **Daemon**: Rust 2024, tokio, axum, rusqlite, clap, notify
- **App**: TypeScript, Bun, React, OpenTUI, Vercel AI SDK, Hono, Drizzle
- **Storage**: SQLite (daemon: rusqlite, app: Drizzle)
- **LLM providers**: OpenRouter, Anthropic, OpenAI

---

## Key files

```
apps/app/src/
  index.tsx              TUI entry point
  worker.ts              Headless worker (autonomous tasks)
  channel-worker.ts      Messaging channel worker
  agent/                 Agent definitions, system prompt
  tool/tool.ts           defineTool(), ToolDefinition, ToolContext
  tool/registry.ts       Tool registration
  tool/security.ts       Sensitive path blocking
  mcp/                   MCP client (stdio, HTTP, SSE)
  session/context.ts     Token estimation, context truncation
  config/                Config loading

apps/daemon/src/
  main.rs                Entry point + run_daemon()
  cli/mod.rs             CLI commands (clap)
  daemon/config.rs       DaemonConfig, JSONC parsing
  orchestrator/mod.rs    Task orchestrator, worker spawning
  orchestrator/worker.rs Worker process management
  triggers/engine.rs     Trigger matching, task creation
  http_api.rs            REST API (axum)
  cron.rs                Cron engine
  watcher.rs             File watcher
  notifications/         Slack, Discord, Email, GitHub, System
```

---

## Patterns

### Adding a tool

1. Create `apps/app/src/tool/<name>.ts` with `defineTool()`
2. Register in `apps/app/src/tool/registry.ts`

### Adding a trigger type

1. Implement listener in `apps/daemon/src/triggers/`
2. Add config types in `daemon/config.rs`
3. Wire into trigger engine and `run_daemon()`

### Adding a notification channel

1. Create `apps/daemon/src/notifications/<provider>.rs`
2. Implement `NotificationChannel` trait
3. Add to `DaemonConfig.build_dispatcher()`

### Adding a CLI command

1. Add variant to `Commands` enum in `cli/mod.rs`
2. Create handler in `cli/<name>.rs`
3. Wire in `main.rs` match block

---

## Communication

- Daemon API: `http://localhost:50051` (axum)
- App server: `http://localhost:7899` (Hono)
- `schedule_task` tool calls `POST /api/schedule` on daemon
- Workers heartbeat via `POST /api/tasks/{id}/heartbeat` every 30s
- Workers report via `POST /api/tasks/{id}/usage` and `/result`

---

## Config files

| File | Purpose |
| --- | --- |
| `~/.kraken/kraken.jsonc` | Triggers, notifications, orchestrator, LLM, MCP |
| `~/.kraken/.env` | API keys and secrets |
| `~/.kraken/data/kraken.db` | Session database |
