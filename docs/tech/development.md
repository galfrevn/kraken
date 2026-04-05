# Development

## Setup

```bash
git clone https://github.com/galfrevn/kraken.git
cd kraken
bun install
bun run dev
```

Requires [Bun](https://bun.sh) 1.3.10+ and [Rust](https://rustup.rs) stable (edition 2024).

---

## Commands

```bash
bun run dev             # Start daemon + TUI in dev mode
bun run build           # Build all packages
bun run lint            # oxlint + cargo clippy
bun run typecheck       # TypeScript type checking
bun run format          # oxfmt + cargo fmt
```

### Daemon only

```bash
cd apps/daemon
cargo build --release
cargo test
cargo clippy -- -D warnings
```

---

## Project structure

```
apps/
  app/              TypeScript — TUI, agent brain, tools, sessions
  daemon/           Rust — Orchestrator, triggers, notifications, HTTP API
packages/
  sdk/              TypeScript SDK for daemon interaction
  skills/           Skill definitions (SKILL.md files)
  configuration/    Shared TypeScript config
  visuals/          Remotion visuals
scripts/
  install.sh        Production installer
  dev/install.sh    Development installer (auto-rebuild shim)
```

---

## Monorepo

Turborepo manages the build pipeline. Bun workspaces handle dependency resolution across packages.

| Layer | Technology |
| --- | --- |
| Monorepo | Turborepo + Bun |
| Daemon | Rust 2024, tokio, axum, rusqlite, clap |
| App/TUI | TypeScript, React, OpenTUI, Vercel AI SDK, Hono, Drizzle |
| Database | SQLite (rusqlite + bun:sqlite) |
| Linting | oxlint + cargo clippy |
| Formatting | oxfmt + cargo fmt |
