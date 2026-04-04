# Vision

## Why Kraken Exists

Most AI coding tools today follow a single interaction model: the developer asks, the agent responds. Tools like Claude Code, OpenCode, Aider, and Cline have proven that LLM-powered agents can be genuine development companions -- but they all require a human in the loop. They wait for input. They don't act on their own.

Kraken takes a different approach. It introduces **persistent autonomy**: an agent that runs continuously, monitors your project, reacts to external events, and executes tasks without requiring constant human supervision. Think of it as a developer that never sleeps.

## Differentiator

| Feature | Traditional AI Agents | Kraken |
| --- | --- | --- |
| Interaction model | Request-response | Event-driven + interactive |
| Runs when | Human is present | 24/7, daemon always on |
| Reacts to | User prompts | Cron, file changes, webhooks, slash commands |
| Task execution | One at a time, foreground | Concurrent background workers |
| Notifications | None | Slack, Discord, email, GitHub |
| Deployment | Local terminal only | Local machine or remote VPS |

The core insight: the terminal agent and the background daemon are complementary, not competing. The TUI is for real-time collaboration. The daemon is for everything else.

## Target Users

**Individual developers** who want to automate repetitive tasks on their local machine: running tests when files change, reviewing PRs on a schedule, fixing CI failures automatically.

**Teams** who want a shared autonomous agent running on a VPS: monitoring repositories, processing webhooks from GitHub, executing scheduled code quality scans, and notifying the team via Slack or Discord.

## Core Principles

1. **The daemon is the backbone.** The TUI is optional. Kraken should be useful even if nobody opens the terminal. The daemon watches, triggers, orchestrates, and notifies on its own.

2. **Event-driven, not prompt-driven.** Cron schedules, file system changes, webhook payloads, and chat mentions are all first-class triggers that feed into the same task pipeline.

3. **Polyglot by design.** Rust for the daemon (performance, OS-level APIs, reliability). TypeScript for the agent brain and TUI (LLM ecosystem, rapid iteration, React-based terminal UI).

4. **Simple to install, simple to configure.** One `curl` command to install. One `kraken init` to configure. One `kraken.jsonc` file for everything.

5. **100% open source.** MIT licensed. No premium tiers, no telemetry, no vendor lock-in.

## Architecture Summary

Kraken is a two-process system:

- **Daemon** (Rust) -- Background service that handles orchestration, scheduling, file watching, webhook ingestion, notifications, and the HTTP API. Always running.
- **App** (TypeScript/React) -- Interactive TUI with the agent brain, tool registry, conversation history, and session management. Runs when the user wants to chat.

They communicate over HTTP REST on localhost. The daemon manages task lifecycle; the app handles LLM interactions and tool execution.

## Roadmap

### Current State

- Daemon with cron, file watchers, webhooks, slash command triggers
- Task orchestrator with retry logic, heartbeat monitoring, git worktrees
- Notification channels: Slack, Discord, Email (Resend), GitHub, System
- Interactive TUI with agent loop and 8 built-in tools (bash, read, write, edit, glob, grep, schedule_task, skill)
- MCP (Model Context Protocol) client support for external tool servers
- Headless worker for autonomous background tasks with heartbeat reporting
- CLI for task management, config, and daemon control
- Installer for macOS and Linux

### Next

- Expand tool set to match modern agent standards (web search, fetch, subagent tasks, batch execution, LSP integration)
- Daemon-side LLM proxy for centralized API key management and cost tracking
- Broader LLM provider support

### Later

- MCP server mode (expose Kraken as a tool provider for external agents)
- Custom tool definitions via configuration
- Multi-repository orchestration
- GitHub Action for CI/CD integration
