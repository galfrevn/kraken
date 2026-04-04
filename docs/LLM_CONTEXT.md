# LLM Context

This document is a condensed reference for AI agents and LLMs working on the Kraken codebase. Read this first for fast orientation.

## What is Kraken

Kraken is an autonomous developer agent with a two-process architecture: a Rust daemon that runs 24/7 (scheduling, triggers, orchestration, notifications) and a TypeScript TUI app for interactive development. The daemon reacts to cron schedules, file changes, and webhooks to create and execute tasks autonomously. The TUI is optional -- the daemon is the backbone.

## Tech Stack

- **Monorepo**: Bun workspaces + Turborepo
- **Daemon**: Rust (edition 2024), tokio, axum, rusqlite, clap, notify, reqwest
- **App/TUI**: TypeScript, Bun, React, OpenTUI (`@opentui/react`), Vercel AI SDK, Hono, Drizzle ORM
- **Storage**: SQLite (daemon: rusqlite, app: bun:sqlite + Drizzle)
- **Linting**: oxlint (TypeScript), cargo clippy (Rust)
- **Formatting**: oxfmt (TypeScript), cargo fmt (Rust)
- **LLM Providers**: OpenRouter, Anthropic, OpenAI

## File Structure

```
apps/app/                  TypeScript TUI + agent brain + headless worker
  src/index.tsx            TUI entry point (interactive mode)
  src/worker.ts            Headless worker entry point (autonomous tasks, no TUI)
  src/agent/               Agent definitions (build, plan) and system prompt
  src/tool/                Tool implementations (bash, read, write, edit, glob, grep, schedule, skill)
  src/tool/tool.ts         Tool interface: defineTool(), ToolDefinition, ToolContext, ToolResult
  src/tool/security.ts     Blocked path detection for sensitive files
  src/tool/registry.ts     Tool registration and resolution for AI SDK
  src/mcp/                 MCP client (stdio, StreamableHTTP, SSE transports)
  src/skill/               Skill discovery and loading (SKILL.md files)
  src/session/             Session + message persistence, context window management
  src/session/context.ts   Token estimation, context truncation, extractive summarization
  src/server/              Internal Hono HTTP server (port 7899, TUI only)
  src/server/routes/files.ts  File search endpoint for @ autocomplete
  src/models/              LLM model registry (models.dev metadata)
  src/provider/            LLM provider configuration
  src/config/              App config loading (~/.kraken/kraken.jsonc)
  src/tui/                 Terminal UI components (OpenTUI/React, TUI only)
  src/bus/                 Event bus for reactive updates
  src/storage/             Drizzle schema, database initialization, migrations

apps/daemon/               Rust daemon
  src/main.rs              Entry point + run_daemon() function
  src/cli/                 CLI commands (clap): start, daemon, init, config, task, trigger, mcp, etc.
  src/daemon/config.rs     DaemonConfig struct, JSONC parsing, all config types
  src/daemon/mod.rs        DaemonState, PID file management
  src/daemon/reload.rs     SIGHUP hot-reload handler
  src/orchestrator/mod.rs  Task orchestrator: polling, worker spawning, heartbeat, notifications
  src/orchestrator/worktree.rs  Git worktree management
  src/orchestrator/worker.rs    Worker process spawning
  src/orchestrator/heartbeat.rs Heartbeat tracking for worker liveness
  src/triggers/engine.rs   Trigger engine: event matching, task creation
  src/triggers/webhook.rs  Webhook HTTP server (axum)
  src/triggers/types.rs    Filter parsing, template rendering
  src/cron.rs              Cron scheduling engine
  src/watcher.rs           File watcher engine (notify crate)
  src/http_api.rs          Daemon HTTP API (axum): tasks, config, secrets, heartbeat, usage
  src/db/tasks.rs          TaskStore: SQLite task persistence
  src/notifications/       Notification channels: slack, discord, email, github, system

packages/configuration/    Shared tsconfig
packages/skills/           Official skill definitions (SKILL.md files)
scripts/install.sh         End-user installer (macOS/Linux)
```

## Key Patterns

### Adding a Tool

1. Create `apps/app/src/tool/<name>.ts`
2. Use `defineTool({ id, description, parameters: z.object({...}), execute })` 
3. Register in `apps/app/src/tool/registry.ts` via `registerTool()`

### Adding a Trigger Type

1. Implement the listener in `apps/daemon/src/triggers/`
2. Add config types in `apps/daemon/src/daemon/config.rs`
3. Wire into the trigger engine in `apps/daemon/src/triggers/engine.rs`
4. Register in `run_daemon()` in `apps/daemon/src/main.rs`

### Adding a Notification Channel

1. Create `apps/daemon/src/notifications/<provider>.rs`
2. Implement the `NotificationChannel` trait (from `types.rs`)
3. Add parsing logic in `DaemonConfig.build_dispatcher()` in `config.rs`

### Adding a CLI Command

1. Add the variant to the `Commands` enum in `apps/daemon/src/cli/mod.rs`
2. Create the handler in `apps/daemon/src/cli/<name>.rs`
3. Wire it in the `match` block in `apps/daemon/src/main.rs`

## Communication

- Daemon HTTP API: `http://localhost:50051` (axum)
- App internal server: `http://localhost:7899` (Hono)
- The `schedule_task` tool in the app calls `POST /api/schedule` on the daemon
- Workers are spawned by the daemon orchestrator as child processes
- Workers send heartbeats via `POST /api/tasks/{id}/heartbeat` every 30s
- Workers report usage via `POST /api/tasks/{id}/usage` and output via `POST /api/tasks/{id}/result`

## Configuration Files

| File | Purpose |
| --- | --- |
| `~/.kraken/kraken.jsonc` | Global config: triggers, notifications, orchestrator, LLM, MCP servers (used by both daemon and app) |
| `~/.kraken/.env` | API keys and secrets |
| `~/.kraken/daemon.pid` | Daemon PID file |
| `~/.kraken/data/kraken.db` | App session database (SQLite) |
| `~/.kraken/cache/modelstate.json` | App model selection state |

## Development Commands

```bash
bun install          # Install all dependencies
bun run dev          # Start daemon + TUI in dev mode (turbo)
bun run lint         # Lint all packages (oxlint + clippy)
bun run format       # Format all packages (oxfmt + cargo fmt)
bun run typecheck    # Type-check all TypeScript
bun run build        # Build all packages
```

## Current State

- 8 built-in tools (bash, read, write, edit, glob, grep, schedule_task, skill)
- All file-access tools enforce security guards against sensitive paths (.env, credentials, secrets)
- MCP client support with tool caching (listed once, reused across turns)
- `@` file references in the TUI prompt with fuzzy autocomplete and context injection
- Context window management: automatic truncation and extractive summarization for long conversations
- Headless worker with heartbeat reporting, usage tracking, output persistence, and exit code forwarding
- Workers use both task name and description as prompt context
- Two agents: `build` (full access) and `plan` (read-only, tool-filtered in both LLM tools and system prompt)
- Automatic stale worktree cleanup every 6 hours (7-day max age)
- Cached language model instances, system prompts, and file indexes for performance
- Webhook server binds to 127.0.0.1 by default (configurable via KRAKEN_WEBHOOK_BIND)
