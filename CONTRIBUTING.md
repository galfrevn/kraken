# Contributing to Kraken

Thanks for your interest in contributing to Kraken! This guide will help you get started.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) 1.3.10+
- [Rust](https://www.rust-lang.org/) (stable, edition 2024)
- [Buf CLI](https://buf.build/) for protobuf generation
- [protoc](https://grpc.io/docs/protoc-installation/) for proto compilation

### Setup

```bash
git clone https://github.com/galfrevn/kraken.git
cd kraken
bash scripts/setup.sh
```

This installs all dependencies, generates protobuf code, builds the Rust and Go binaries, and links the CLI.

### Running in Development

```bash
bun run dev
```

## Project Structure

Kraken is a monorepo with three core services:

| App              | Language         | Purpose                                                        |
| ---------------- | ---------------- | -------------------------------------------------------------- |
| `apps/cli`       | TypeScript       | CLI entry point and process orchestration                      |
| `apps/core`      | TypeScript       | Agent brain — execution loop, tools, storage, plugins          |
| `apps/daemon`    | Rust             | Full daemon: LLM proxy, orchestrator, cron, watchers, webhooks |
| `apps/tui`       | TypeScript/React | Terminal UI (OpenTUI)                                          |

Shared packages live in `packages/` and protobuf definitions in `proto/agent/v1/`.

## Making Changes

### 1. Create a Branch

```bash
git checkout -b feat/your-feature
```

Use conventional prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `ci/`.

### 2. Write Your Code

- **TypeScript:** No build step needed in dev — Bun resolves `.ts`/`.tsx` imports directly
- **Protobuf changes:** Edit files in `proto/agent/v1/`, then run `bun run generate`
- **Plugins:** Implement `KrakenPlugin` from `@kraken/sdk` — see `packages/plugins/` for examples

### 3. Check Your Work

```bash
bun run format          # Format code (oxfmt)
bun run lint            # Lint (oxlint)
bun run typecheck       # Type-check all TypeScript

# Per-service tests
cd apps/core && bun test
cd apps/daemon && cargo test
```

### 4. Commit

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new tool for X
fix: handle edge case in parser
refactor: simplify plugin loader
docs: update configuration guide
ci: add caching to build workflow
```

### 5. Open a Pull Request

- Keep PRs focused — one feature or fix per PR
- Fill out the PR template
- Make sure CI passes before requesting review

## Where to Contribute

- **Good first issues:** Look for issues labeled [`good first issue`](https://github.com/galfrevn/kraken/labels/good%20first%20issue)
- **Plugins:** The plugin system is designed for extensibility — new plugins are always welcome
- **Tools:** Agent tools live in `apps/core/src/tools/` — adding new capabilities is straightforward
- **Documentation:** Improvements to docs, examples, and guides are valuable

## Architecture Notes

- **Cross-language contracts** are defined in protobuf (`proto/agent/v1/`). If you change a `.proto` file, regenerate with `bun run generate`.
- **The agent uses XML-based tool calling**, not native provider APIs. See `apps/core/src/agent/parser.ts`.
- **SQLite** is the persistence layer (WAL mode, via `bun:sqlite`). Migrations are inline in `apps/core/src/storage/database.ts`.
- **Configuration** layers: `~/.kraken/.env` → `~/.kraken/kraken.yml` → env vars. Schema is Zod-validated.

## Questions?

Open a [discussion](https://github.com/galfrevn/kraken/discussions) or reach out via issues. We're happy to help you find the right place to contribute.
