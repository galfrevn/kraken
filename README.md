<p align="center">
  <img src="docs/assets/kraken.gif" alt="Kraken" width="700" />
</p>

<h1 align="center">Kraken</h1>

<p align="center">
  <strong>An autonomous developer agent that lives in your terminal — and your messaging apps.</strong>
</p>

<p align="center">
  Kraken understands your codebase, runs tasks on a schedule, watches your files for changes, receives webhooks, integrates with GitHub for PR and issue management, sends notifications across multiple channels, and connects to Telegram, Discord and other messaging platforms — all while acting autonomously. Think of it as a developer that never sleeps.
</p>

---

## Motivation

Most AI coding tools today follow a single interaction model: the developer asks, the agent responds. Tools like [Claude Code](https://github.com/anthropics/claude-code), [OpenCode](https://github.com/anomalyco/opencode), and others have proven that LLM-powered agents can be genuine companions for developers — but they all require a human in the loop.

Kraken takes this further by introducing **persistent autonomy**. Rather than waiting for human input, Kraken can monitor file changes, respond to webhooks, execute scheduled tasks, manage GitHub PRs and issues, notify your team across multiple channels, and ask you questions when it needs input — all while maintaining a rich terminal interface for real-time collaboration when you need it.

The TUI is optional. The daemon is the backbone.

<p align="center">
  <img src="docs/assets/front.png" alt="Kraken" width="700" />
</p>

---

## Architecture

Kraken is a multi-process system: a Rust daemon and a TypeScript app communicating over HTTP REST on localhost, plus optional messaging channel workers.

The **Daemon** (Rust) handles orchestration, cron scheduling, file watching, webhook ingestion, task management, and notifications. It uses tokio for async execution, notify for file system events, and axum for the HTTP API.

The **App** (TypeScript/React) contains the agent brain — the LLM execution loop, tool registry, conversation history, and terminal UI. It uses the Vercel AI SDK, OpenTUI for rendering, and SQLite for session storage.

**Channel Workers** (TypeScript) bridge external messaging platforms (Telegram, Discord, etc.) with the agent, enabling remote task submission and real-time responses.

| Service | Language | Port | Role |
| --- | --- | --- | --- |
| **Daemon** | Rust | 50051 | Orchestrator, cron, watchers, webhooks, notifications, GitHub integration |
| **App** | TypeScript | 7899 | TUI, agent brain, tools, sessions, LSP, MCP |
| **Channels** | TypeScript | — | Messaging adapters (Telegram, Discord, etc.) |

```
┌──────────────────────────────────────────────┐
│                   CLI                        │
│            (spawns & orchestrates)           │
├──────────────────┬───────────────────────────┤
│     Daemon       │          App             │
│     (Rust)       │      (TypeScript)         │
│                  │                          │
│  • Orchestrator  │  • Agent loop            │
│  • Cron jobs     │  • Tools (27 built-in)   │
│  • Watchers      │  • LSP diagnostics       │
│  • Webhooks      │  • MCP servers           │
│  • Notifications │  • Sub-agents            │
│  • Multi-repo    │  • Sessions & memory     │
│  • GitHub API    │  • Audit logging         │
│  • Channel mgmt  │  • Task tracking         │
└────────┬─────────┴──────────┬───────────────┘
         │  HTTP REST (localhost)  │
         └────────────────────────┘
                    │
         ┌──────────┴──────────┐
         │   Channel Workers   │
         │  (Telegram, Discord)│
         └─────────────────────┘
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

The agent ships with a comprehensive toolset for autonomous development:

| Tool | Description |
| --- | --- |
| `bash` | Execute shell commands |
| `read` | Read file contents with line numbers |
| `write` | Create or overwrite files |
| `edit` | Replace exact string matches in files |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents with regex |
| `security` | Analyze code for vulnerabilities and secrets |
| `schedule_task` | Schedule tasks on the daemon (cron, deferred, recurring) |
| `skill` | Load specialized skill instructions |
| `memory_save` | Save observations to persistent memory |
| `memory_search` | Search persistent memory |
| `memory_context` | Load recent memory for current project |
| `task_list` | List daemon tasks with status filtering |
| `task_get` | Get task details and output |
| `task_delete` | Delete pending/cancelled tasks |
| `webfetch` | Fetch web pages as markdown/text |
| `websearch` | Search the web for real-time info |
| `subagent` | Delegate to specialized sub-agents (explore, general) |
| `question` | Ask the user structured questions with selectable options |
| `todowrite` | Create and manage task lists for multi-step work |
| `channel_send` | Send messages to connected channels (Telegram, Discord) |
| `github_pr_list` | List pull requests on a GitHub repository |
| `github_pr_get` | Get details of a specific pull request |
| `github_pr_create` | Create a new pull request |
| `github_pr_comment` | Post a comment on a PR or issue |
| `github_pr_merge` | Merge a pull request |
| `github_issue_list` | List issues on a GitHub repository |
| `github_issue_create` | Create a new issue on GitHub |

Tools include automatic rate limiting (200 calls/session), audit logging, and LSP diagnostics that run automatically after file edits.

### MCP Support

Kraken connects to **Model Context Protocol** servers, extending the agent with external tools:

```jsonc
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "enabled": true
    },
    "github": {
      "type": "remote",
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

Supports both **stdio** (local) and **HTTP/SSE** (remote) transports. MCP tools are automatically registered alongside built-in tools.

---

## SDK

A TypeScript SDK is available for programmatic interaction with the daemon:

```typescript
import { DaemonClient } from "@kraken/sdk";

const client = new DaemonClient({ baseUrl: "http://localhost:50051" });

// Schedule tasks
const task = await client.schedule({ prompt: "Run tests", priority: 5 });

// Query memory
const results = await client.memorySearch({ query: "api keys" });

// Manage tasks
await client.tasks.list({ status: "running" });
await client.tasks.get(taskId);
await client.tasks.delete(taskId);

// Stream events
client.onEvent("task_completed", (event) => console.log(event));
```

See [`packages/sdk/`](packages/sdk/) for the full API.

---

## Skills System

Skills provide specialized instructions for specific tasks. They're loaded on-demand:

- **memory** — Persistent memory management
- **triggers** — Cron jobs, webhooks, file watchers
- **secrets** — API key and secret management
- **websearch** — Web search configuration
- **heartbeat** — Autonomous periodic task execution
- **daemon** — Daemon management and maintenance
- **notifications** — Slack, Discord, Email, GitHub notifications
- **channels** — External messaging adapters (Telegram, Discord, etc.)
- **repos** — Multi-repo configuration and management
- **lsp** — Language Server Protocol integration

Skills are defined in [`packages/skills/`](packages/skills/) and can be extended.

---

## LSP Integration

Kraken integrates with Language Server Protocol servers to provide real-time code diagnostics. After editing files, the agent automatically:

1. Collects diagnostics from the LSP server
2. Injects errors and warnings into the agent context
3. Can auto-fix issues based on diagnostic feedback

```jsonc
{
  "lsp": {
    "enabled": true,
    "servers": {
      "typescript": {
        "command": ["typescript-language-server", "--stdio"],
        "rootPatterns": ["tsconfig.json", "package.json"]
      }
    }
  }
}
```

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
  app/            TypeScript/React — TUI + agent brain, tools, sessions, LSP, MCP
  daemon/         Rust — Daemon: orchestrator, cron, watchers, webhooks, multi-repo, GitHub
packages/
  configuration/  Shared TypeScript config types
  sdk/            TypeScript SDK for programmatic daemon interaction
  skills/         Skill definitions (memory, triggers, secrets, etc.)
  visuals/        Remotion visuals and animations
docs/             Documentation (architecture, tools, config, daemon, roadmap)
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
