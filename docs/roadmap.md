# Kraken Roadmap

## Documentation

- [ ] README with installation, architecture overview, and screenshots
- [ ] Plugin development guide with SDK reference
- [ ] Configuration reference for `kraken.yml`
- [ ] Contributing guide

## Testing

- [ ] Core: tools, plugin registry, config loader, conversation history
- [ ] CLI: init wizard, start, config, doctor, plugins commands
- [ ] TUI: command parsing, tool accordion, plugin store dialog
- [ ] SDK: plugin loading, hook dispatching
- [ ] Plugins: nanobanana, browser

## CI/CD

- [ ] GitHub Actions: lint, typecheck, tests on PR
- [ ] Release workflow with pre-built binaries (macOS, Linux)
- [ ] Automated plugin registry validation
- [ ] Version bumping and changelog generation

## Autonomous Mode

- [ ] Task planner: agent breaks down a high-level goal into subtasks
- [ ] Execution loop: agent works through subtasks without user input
- [ ] Progress reporting: real-time status updates in TUI
- [ ] Pause/resume: user can interrupt and redirect the agent mid-plan
- [ ] Error recovery: agent retries or asks for help on failure

## Context Management

- [ ] Token counting per message and cumulative
- [ ] Automatic conversation pruning when approaching model limits
- [ ] Smart summarization of older messages to preserve context
- [ ] File content caching to avoid re-reading unchanged files

## Plugins

- [ ] Docker: build, run, manage containers
- [ ] Database: query, migrate, seed (Postgres, SQLite)
- [ ] Git advanced: interactive rebase, cherry-pick, bisect, stash
- [ ] Linter: run ESLint/Biome and auto-fix issues
- [ ] Test runner: execute and parse test results (Vitest, Jest, pytest)
- [ ] HTTP client: make API requests and inspect responses
- [ ] Markdown preview: render markdown in terminal

## Security

- [ ] Command execution sandboxing with allowlist/blocklist
- [ ] Per-plugin permission model (filesystem, network, shell)
- [ ] Confirmation prompts for destructive actions across all tools
- [ ] API key rotation and secure storage

## Delegation

- [ ] Sub-agent spawning with faster/cheaper models for simple tasks
- [ ] Parallel task execution across multiple sub-agents
- [ ] Result aggregation from sub-agents back to main agent
- [ ] Model-aware routing: match task complexity to model capability

## TUI Improvements

- [ ] Split pane view: code + chat side by side
- [ ] File tree browser with inline preview
- [ ] Diff viewer for file changes before applying
- [ ] Notification system for background task completion
- [ ] Theme customization via config

## Infrastructure

- [ ] Webhook support: trigger agent actions from external events
- [ ] REST API for programmatic access alongside ConnectRPC
- [ ] Metrics and observability (request latency, token usage, errors)
- [ ] Multi-user support with authentication
