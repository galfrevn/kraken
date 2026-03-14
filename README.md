<p align="center">
  <img src="docs/assets/kraken-logo.png" alt="Kraken" width="120" />
</p>

<h1 align="center">Kraken</h1>

<p align="center">
  <strong>An autonomous developer agent that lives in your terminal.</strong>
</p>

<p align="center">
  Kraken understands your codebase, runs tasks on a schedule, watches your files for changes, receives webhooks — and acts on all of it autonomously. Think of it as a developer that never sleeps.
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="Kraken demo" width="800" />
</p>

---

## What is Kraken?

Kraken is an AI-powered autonomous agent with a **three-process architecture**: a Rust scheduler, a Go gateway, and a TypeScript TUI — all orchestrated from a single CLI command. It doesn't just answer questions — it monitors, schedules, reacts, and executes.

<p align="center">
  <img src="docs/assets/architecture.png" alt="Architecture overview" width="700" />
</p>

### Key capabilities

- **Autonomous execution** — Kraken runs tasks, commits code, manages PRs, and responds to events without manual intervention
- **Cron scheduling** — Define recurring jobs (review PRs, run tests, sync repos) with standard cron expressions
- **File watching** — Monitor directories and trigger actions on changes with configurable debounce and ignore patterns
- **Webhook ingestion** — Receive GitHub/GitLab webhooks with signature validation and route events to tasks
- **Plugin system** — Extend functionality with plugins that register tools, hook into the agent lifecycle, and declare config schemas
- **Multi-provider LLM support** — Works with OpenRouter, Anthropic, and OpenAI out of the box
- **Terminal UI** — A rich React-based TUI for real-time interaction, built with OpenTUI

---

## Get started

### Prerequisites

- [Bun](https://bun.sh) 1.3.10+
- [Go](https://go.dev) 1.26+
- [Rust](https://rustup.rs) (edition 2024)
- [Buf CLI](https://buf.build/docs/installation) (for protobuf generation)

### Quick setup

```bash
git clone https://github.com/valentin-galfre/kraken.git
cd kraken
bash scripts/setup.sh
```

The setup script installs dependencies, generates protobuf code, builds the Rust and Go services, and links the CLI.

### Manual setup

```bash
# Install dependencies
bun install

# Generate protobuf code
bun run generate

# Build all services
bun run build

# Start in dev mode
bun run dev
```

### Configuration

Kraken uses a layered configuration system:

```
~/.kraken/.env          → Environment variables
~/.kraken/kraken.yml    → Main configuration
ENV overrides           → Runtime overrides
```

Set your LLM provider key:

```bash
# Any of these work
export ANTHROPIC_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
export KRAKEN_OPENROUTER_API_KEY="sk-..."
```

---

## Architecture

Kraken runs as three cooperating processes on localhost, communicating over ConnectRPC:

| Service | Language | Port | Role |
|---------|----------|------|------|
| **Scheduler** | Rust | 50051 | Cron engine + file watchers, streams events via gRPC |
| **Gateway** | Go | 50052 | LLM proxy (multi-provider) + webhook receiver |
| **TUI** | TypeScript | — | Terminal UI, agent brain, tools, storage |

```
┌─────────────────────────────────────────────────┐
│                     CLI                         │
│              (spawns & orchestrates)             │
├────────────────┬────────────────┬───────────────┤
│   Scheduler    │    Gateway     │     TUI       │
│    (Rust)      │     (Go)      │ (TypeScript)   │
│                │               │               │
│  • Cron jobs   │  • LLM proxy  │  • Agent loop │
│  • Watchers    │  • Webhooks   │  • Tools      │
│  • Events      │  • Streaming  │  • Storage    │
│                │               │  • Plugins    │
└────────┬───────┴───────┬───────┴───────┬───────┘
         │    ConnectRPC (localhost)      │
         └───────────────────────────────┘
```

---

## Scheduling & automation

### Cron jobs

Define recurring tasks in `kraken.yml`:

```yaml
scheduler:
  crons:
    - name: review-prs
      expression: "0 9 * * *"
      task: review-open-prs
      enabled: true

    - name: run-tests
      expression: "*/30 * * * *"
      task: run-test-suite
      enabled: true
```

### File watchers

Monitor directories and react to changes:

```yaml
scheduler:
  watchers:
    - name: src-watcher
      paths: ["./src", "./lib"]
      ignore: ["node_modules", ".git", "dist"]
      debounce_ms: 500
```

### Webhooks

Receive events from GitHub, GitLab, or custom sources with HMAC signature validation:

```yaml
webhooks:
  - name: github-push
    provider: github
    secret: "whsec_..."
    events: ["push", "pull_request"]
```

---

## Plugin system

Extend Kraken with plugins that hook into the agent lifecycle:

```typescript
import { definePlugin } from "@kraken/sdk";

export default definePlugin({
  name: "my-plugin",
  version: "1.0.0",

  tools: [
    {
      name: "my_tool",
      description: "Does something useful",
      parameters: [{ name: "input", type: "string", required: true }],
      async execute(params) {
        return { success: true, output: `Processed: ${params.input}` };
      },
    },
  ],

  hooks: {
    beforeToolCall(toolName, params) { /* ... */ },
    afterToolCall(toolName, result) { /* ... */ },
    onConversationStart(context) { /* ... */ },
  },
});
```

---

## Built-in tools

Kraken comes with a comprehensive set of tools the agent can use autonomously:

| Category | Tools |
|----------|-------|
| **Files** | `read_file`, `write_file`, `edit_file`, `delete_file`, `move_file`, `list_directory`, `glob_files`, `search_files` |
| **Git** | `git_status`, `git_diff`, `git_commit`, `git_log` |
| **Code** | `code_outline`, `diff_files`, `replace_in_files`, `read_lines` |
| **Web** | `web_search`, `fetch_url`, `http_request` |
| **Scheduling** | `schedule_cron`, `list_schedules`, `delete_schedule`, `schedule_watcher`, `list_watchers`, `delete_watcher` |
| **Memory** | `remember`, `recall`, `index_project` |
| **Tasks** | `task_list`, `task_submit`, `schedule_once`, `list_timers`, `cancel_timer` |
| **System** | `run_command`, `environment`, `view_image`, `count_tokens` |
| **Model** | `model_list`, `model_switch`, `current_model`, `delegate` |

---

## Development

```bash
# Run all services in dev mode
bun run dev

# Type-check everything
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Run tests (core)
cd apps/core && bun test

# Build scheduler only
cd apps/scheduler && cargo build --release

# Build gateway only
cd apps/gateway && go build -o ./bin/gateway ./cmd/gateway
```

---

## Project structure

```
apps/
  cli/            TypeScript — CLI entry point, process orchestration
  core/           TypeScript — Agent brain: execution loop, tools, storage, plugins
  gateway/        Go — LLM proxy + webhook receiver (ConnectRPC)
  scheduler/      Rust — Cron engine + file watcher (gRPC/tonic)
  tui/            TypeScript/React — Terminal UI (OpenTUI)
packages/
  sdk/            Plugin authoring API
  plugins/        Official plugin registry
  configuration/  Shared TypeScript config
proto/agent/v1/   Protobuf definitions (single source of truth)
gen/
  ts/             Generated TypeScript (protobuf-es)
  go/             Generated Go (protoc-gen-go + connect-go)
```

---

## Tech stack

- **Monorepo**: Turborepo + Bun
- **TypeScript**: ESNext, strict mode, `verbatimModuleSyntax`
- **TUI**: OpenTUI (`@opentui/react`)
- **Go**: 1.26 (gateway)
- **Rust**: Edition 2024, tokio async (scheduler)
- **RPC**: ConnectRPC, protobuf
- **Database**: SQLite via `bun:sqlite` (WAL mode)
- **Linting**: oxlint
- **Formatting**: oxfmt

---

## License

MIT
