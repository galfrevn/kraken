<p align="center">
  <img src="docs/assets/kraken.gif" alt="Kraken" width="700" />
</p>

<h1 align="center">Kraken</h1>

<p align="center">
  Autonomous coding agent with triggers, channels, and zero hand-holding.
</p>

<br />

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash
```

Requires macOS or Linux. Bun is installed automatically if missing.

## What is Kraken

Kraken is a two-process system — a Rust daemon and a TypeScript agent — that runs tasks autonomously. It reacts to cron schedules, file changes, webhooks, and messages from Telegram or Discord. The terminal UI is for when you want to collaborate. The daemon is for everything else.

<p align="center">
  <img src="docs/assets/front.png" alt="Kraken TUI" width="700" />
</p>

## Documentation

### Getting started

- [Installation](docs/general/install.md) — Requirements, setup, and first run
- [Configuration](docs/general/configuration.md) — Full `kraken.jsonc` schema reference
- [CLI](docs/general/cli.md) — Every available command

### Guides

- [Triggers](docs/guides/triggers.md) — Cron jobs, file watchers, webhooks
- [Notifications](docs/guides/notifications.md) — Slack, Discord, Email, GitHub
- [Channels](docs/guides/channels.md) — Telegram and Discord messaging adapters
- [MCP Servers](docs/guides/mcp.md) — External tool providers via Model Context Protocol

### Technical

- [Architecture](docs/tech/architecture.md) — System design, processes, and data flows
- [Tools](docs/tech/tools.md) — Built-in tool catalog and custom tool development
- [HTTP API](docs/tech/http-api.md) — Daemon REST API reference
- [SDK](docs/tech/sdk.md) — TypeScript client library
- [LLM Context](docs/tech/llm-context.md) — Condensed reference for AI agents

## Contributing

See [Development Guide](docs/tech/development.md) for setup, build commands, and contribution guidelines.

## License

MIT
