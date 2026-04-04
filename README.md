<p align="center">
  <img src="docs/assets/kraken.gif" alt="Kraken" width="700" />
</p>

<h1 align="center">Kraken</h1>

<p align="center">
  <strong>An autonomous developer agent that lives in your terminal.</strong>
</p>

<p align="center">
  Kraken understands your codebase, runs tasks on a schedule, watches your files for changes, receives webhooks — and acts on all of it autonomously. Think of it as a developer that never sleeps.
</p>

---

## Motivation

Most AI coding tools today follow a single interaction model: the developer asks, the agent responds. Tools like [Claude Code](https://github.com/anthropics/claude-code), [OpenCode](https://github.com/anomalyco/opencode), and others have proven that LLM-powered agents can be genuine companions for developers — but they all require a human in the loop.

Kraken takes this further by introducing **persistent autonomy**. Rather than waiting for human input, Kraken can monitor file changes, respond to webhooks, execute scheduled tasks, and notify your team — all while maintaining a rich terminal interface for real-time collaboration when you need it.

The TUI is optional. The daemon is the backbone.

<p align="center">
  <img src="docs/assets/front.png" alt="Kraken" width="700" />
</p>

---

## Architecture

Kraken is a two-process system: a Rust daemon and a TypeScript app communicating over HTTP REST on localhost.

The **Daemon** (Rust) handles orchestration, cron scheduling, file watching, webhook ingestion, task management, and notifications. It uses tokio for async execution, notify for file system events, and axum for the HTTP API.

The **App** (TypeScript/React) contains the agent brain — the LLM execution loop, tool registry, conversation history, and terminal UI. It uses the Vercel AI SDK, OpenTUI for rendering, and Drizzle ORM for session storage.

| Service | Language | Port | Role |
| --- | --- | --- | --- |
| **Daemon** | Rust | 50051 | Orchestrator, cron, watchers, webhooks, notifications |
| **App** | TypeScript | 7899 | TUI, agent brain, tools, sessions |

```
┌──────────────────────────────────────┐
│                CLI                   │
│         (spawns & orchestrates)      │
├──────────────────┬───────────────────┤
│     Daemon       │       App        │
│     (Rust)       │   (TypeScript)   │
│                  │                  │
│  • Orchestrator  │  • Agent loop    │
│  • Cron jobs     │  • Tools         │
│  • Watchers      │  • Storage       │
│  • Webhooks      │  • TUI           │
│  • Notifications │  • Sessions      │
└────────┬─────────┴─────────┬────────┘
         │  HTTP REST (localhost)  │
         └────────────────────────┘
```

For more details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Installation

### Quick install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash
```

This will:
1. Detect your platform (macOS or Linux, x64 or arm64)
2. Install Bun and Rust if they're missing
3. Clone and build the daemon, CLI, and TUI from source
4. Add `kraken` to your PATH
5. Run `kraken init` to walk you through initial configuration (LLM provider, API key, etc.)

### From source

```bash
git clone https://github.com/galfrevn/kraken.git
cd kraken
bun install
bun run dev
```

Requires [Bun](https://bun.sh) 1.3.10+ and [Rust](https://rustup.rs) (stable, edition 2024).

### Verify installation

```bash
kraken --help           # Print available commands
kraken daemon status    # Check daemon status
```

---

## Configuration

Kraken uses a layered configuration system: `~/.kraken/.env` (API keys) → `~/.kraken/kraken.jsonc` (daemon config) → environment variable overrides.

To get started, set your LLM provider key:

```bash
export OPENROUTER_API_KEY="sk-or-..."
# or
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-..."
```

For the full configuration reference, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Scheduling & Automation

### Cron jobs

```jsonc
{
  "triggers": {
    "crons": [
      {
        "name": "review-prs",
        "expression": "0 0 9 * * *",
        "task": "Review all open PRs and summarize findings"
      }
    ]
  }
}
```

### File watchers

```jsonc
{
  "triggers": {
    "watchers": [
      {
        "name": "src-watcher",
        "paths": ["./src", "./lib"],
        "ignore": ["node_modules", ".git", "dist"],
        "debounceMs": 500,
        "task": "File changed: {{event.path}}"
      }
    ]
  }
}
```

### Webhooks

```jsonc
{
  "triggers": {
    "webhooks": [
      {
        "name": "github-push",
        "provider": "github",
        "secret": "${GITHUB_WEBHOOK_SECRET}",
        "events": [
          {
            "type": "push",
            "filter": [
              "ref equals 'refs/heads/main'"
            ],
            "task": "Run tests for push to main"
          }
        ]
      }
    ]
  }
}
```

For the full trigger reference, see [docs/DAEMON.md](docs/DAEMON.md).

---

## Built-in Tools

The agent ships with tools for common development tasks:

| Tool | Description |
| --- | --- |
| `bash` | Execute shell commands |
| `read` | Read file contents with line numbers |
| `write` | Create or overwrite files |
| `edit` | Replace exact string matches in files |
| `glob` | Find files by glob pattern (via ripgrep) |
| `grep` | Search file contents with regex (via ripgrep) |
| `schedule_task` | Schedule tasks on the daemon |

More tools are planned: web search, URL fetching, subagent tasks, batch execution, and LSP integration. See [docs/TOOLS.md](docs/TOOLS.md).

---

## Development

```bash
bun run dev             # Start daemon + TUI in dev mode
bun run typecheck       # Type-check all TypeScript
bun run lint            # Lint (oxlint + cargo clippy)
bun run format          # Format (oxfmt + cargo fmt)
cd apps/daemon && cargo test  # Run daemon tests
```

---

## Project Structure

```
apps/
  app/            TypeScript/React — TUI + agent brain, tools, sessions
  daemon/         Rust — Daemon: orchestrator, cron, watchers, webhooks
packages/
  configuration/  Shared TypeScript config
docs/             Documentation (architecture, tools, config, daemon)
scripts/
  install.sh      End-user installer (macOS/Linux)
```

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Monorepo | Turborepo + Bun |
| TypeScript | ESNext, strict mode |
| TUI framework | OpenTUI (`@opentui/react`) |
| Daemon | Rust (edition 2024), tokio, axum |
| Communication | HTTP REST (localhost) |
| Database | SQLite (rusqlite + bun:sqlite) |
| Linting | oxlint + cargo clippy |
| Formatting | oxfmt + cargo fmt |

---

## Documentation

| Document | Description |
| --- | --- |
| [docs/VISION.md](docs/VISION.md) | Product vision, principles, and roadmap |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture and data flows |
| [docs/TOOLS.md](docs/TOOLS.md) | Agent tools catalog (current + planned) |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Full configuration reference |
| [docs/DAEMON.md](docs/DAEMON.md) | CLI reference, triggers, orchestrator, HTTP API |
| [docs/LLM_CONTEXT.md](docs/LLM_CONTEXT.md) | Condensed context for AI agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor guide |

---

## License

MIT
