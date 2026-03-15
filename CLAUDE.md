# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Kraken

Kraken is an autonomous developer agent with a two-process architecture: a **Rust daemon** (LLM proxy, orchestrator, cron, file watchers, webhooks, notifications) and a **TypeScript TUI** (React terminal UI via OpenTUI). The CLI spawns both and orchestrates communication over ConnectRPC on localhost.

## Common Commands

### Root-level (Turborepo, uses Bun)

```bash
bun install               # Install all workspace dependencies
bun run dev               # Start all apps in dev mode (persistent, no cache)
bun run build             # Build all apps in dependency order
bun run typecheck         # Type-check all workspaces
bun run lint              # Lint all workspaces
bun run format            # Format all workspaces (oxfmt)
bun run generate          # Regenerate protobuf code (buf generate → gen/ts/ + gen/go/)
bun run proto:lint        # Lint proto definitions (buf lint)
```

### Per-app commands

```bash
# Core (TypeScript) — run from apps/core/
bun test                  # Run tests (only core has tests currently)
bun run build             # bun build src/index.ts --outdir dist --target bun

# Daemon (Rust) — run from apps/daemon/
cargo build --release
cargo test
cargo clippy -- -D warnings
cargo check

# TUI (TypeScript/React) — run from apps/tui/
bun run build             # bun build src/index.tsx --outdir dist --target bun
```

### Developer setup from scratch

```bash
bash scripts/setup.sh     # Installs deps, generates proto, builds Rust, links CLI
```

## Architecture

### Monorepo Layout

```
apps/
  cli/          # TypeScript — CLI entry point, command dispatch, process orchestration
  core/         # TypeScript — Agent brain: execution loop, tools, storage, plugins, clients
  daemon/       # Rust — Full daemon: LLM proxy, orchestrator, cron, file watchers, webhooks
  tui/          # TypeScript/React — Terminal UI (OpenTUI), composes all core subsystems
packages/
  configuration/  # Shared tsconfig.base.json (all TS apps extend this)
  sdk/            # Plugin authoring API: KrakenPlugin interface + definePlugin()
  plugins/        # Official plugin registry (registry.json + plugin directories)
proto/agent/v1/   # Protobuf definitions — single source of truth for all RPC contracts
gen/
  ts/             # buf-generated TypeScript (protobuf-es)
  go/             # buf-generated Go (protoc-gen-go + connect-go)
```

### Key Architectural Patterns

**No build step in dev for TypeScript.** The TUI's `tsconfig.json` maps `@/*` to both `./src/*` and `../core/src/*`. The CLI dynamically imports `apps/tui/src/index.tsx` at runtime. Bun resolves `.ts`/`.tsx` imports directly.

**Protobuf as the API contract.** All cross-language contracts live in `proto/agent/v1/`. Buf generates TS and Go code. The Rust daemon compiles protos separately via `tonic_build` in `build.rs`.

**XML-based tool-calling protocol.** The agent emits `<tool_call>{"name": "...", "parameters": {...}}</tool_call>` tags instead of native provider tool-calling APIs. This makes the system LLM-provider-agnostic. Parsing is in `apps/core/src/agent/parser.ts`.

**Plugin system.** Plugins implement `KrakenPlugin` from `@kraken/sdk`. They can register tools, hook into `beforeToolCall`/`afterToolCall`/`onConversationStart`/`onConversationEnd`, extend the system prompt, and declare config schemas. Loaded dynamically via `await import()`.

**SQLite state store.** All persistent state (tasks, threads, messages, memory facts) is in a single SQLite file via `bun:sqlite` with WAL mode. Migrations are inline in `apps/core/src/storage/database.ts`.

**Configuration layering.** `~/.kraken/.env` → `~/.kraken/kraken.yml` → env var overrides. Schema validated with Zod in `apps/core/src/configuration/schema.ts`.

### Service Ports

| Service | Default Port | Env Variable     |
| ------- | ------------ | ---------------- |
| Daemon  | 50051        | `SCHEDULER_PORT` |

### Key Environment Variables

| Variable                                                                                    | Purpose                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `KRAKEN_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | LLM provider API key                                        |
| `BRAVE_SEARCH_API_KEY`                                                                      | Web search tool                                             |
| `KRAKEN_CONFIGURATION_FILE`                                                                 | Override config file path (default: `~/.kraken/kraken.yml`) |
| `KRAKEN_SCHEDULER_URL`                                                                      | Override daemon service URL                                 |

## Tech Stack

- **Package manager:** Bun 1.3.10
- **Monorepo:** Turborepo
- **TypeScript:** ESNext target, strict mode, `verbatimModuleSyntax: true`
- **TUI framework:** OpenTUI (`@opentui/react`) — not Ink, not DOM
- **JSX:** `jsxImportSource: "@opentui/react"` in tsconfig
- **Rust:** Edition 2024, tokio async (daemon)
- **RPC:** ConnectRPC (HTTP/1.1 + H2C), protobuf
- **Database:** SQLite via `bun:sqlite`
- **Linting:** oxlint (config: `.oxlintrc.json`)
- **Formatting:** oxfmt
- **Config validation:** Zod v4
