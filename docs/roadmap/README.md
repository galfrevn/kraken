# Kraken Roadmap

This directory contains detailed implementation specifications for planned features. Each document is designed to be self-contained — an LLM or developer can pick up any document and implement the feature with full context.

## Completed Features

| # | Feature | Status |
|---|---------|--------|
| 010 | Hot Config Reload | **Done** — HTTP reload endpoint, file watcher with debounce, config validation + diff |
| 011 | Sub-Agents & Per-Agent Model Routing | **Done** — Sub-agent system with child sessions, per-agent models, explore/general agents |
| 012 | Context Window Management | **Done** — Extractive summary, tool result truncation, token estimation |
| 013 | Persistent Memory | **Done** — memory_save, memory_search, memory_context tools, daemon Memory API |
| 014 | Tool Result Caching | **Done** — FileCache + ToolResultCache with mtime validation, LRU eviction |
| 016 | Audit Log | **Done** — AuditStore, HTTP API, SDK, CLI |
| 018 | Rate Limiting | **Done** — RateLimiter, LoopDetector, per-session tool limits |
| 019 | Streaming Improvements | **Done** — Live bash stdout streaming via Bus events |
| 020 | `kraken doctor` | **Done** — Diagnostic checks, auto-fix, JSON output |
| — | Multi-Channel Messaging (Telegram + Discord) | **Done** — ChannelAdapter trait, DM policies (Pairing/Allowlist/Disabled), user authorization with pairing codes, draft streaming, typing indicators |
| — | Channel Slash Commands | **Done** — /task, /new, /model, /cost, /status, /repos, /users, /help — intercepted before LLM, zero token cost |
| — | Background Tasks from Channels | **Done** — `/task` command creates orchestrator tasks from Telegram/Discord with channel reply notifications |
| — | Multi-Repo Support | **Done** — `repos` config with named paths, `--repo=` flag in /task, /repos command |
| — | Cost Tracking | **Done** — Dynamic pricing from OpenRouter API, worker reports real costs, `/cost` command |
| — | Model Sync (TUI ↔ Channels) | **Done** — modelstate.json shared between TUI and channel workers, `/model` command |

## Planned Features

### Rust Optimizations

| # | Document | Summary |
|---|----------|---------|
| 001 | [Tree-sitter AST Parsing](./001-tree-sitter-ast-parsing.md) | Code-aware parsing in Rust for structural understanding of source files |
| 002 | [Code Search Index](./002-code-search-index.md) | Persistent trigram-based search index replacing per-query `rg` spawning |
| 003 | [Codebase Dependency Graph](./003-codebase-dependency-graph.md) | Import/export analysis for impact analysis and dependency queries |
| 004 | [Embedding Store & Semantic Search](./004-embedding-store-semantic-search.md) | Vector embeddings in SQLite for meaning-based code search |
| 005 | [Unified Storage](./005-unified-storage.md) | Consolidate daemon + app SQLite databases into one |
| 006 | [Worker Health Monitoring](./006-worker-health-monitoring.md) | Per-worker CPU/memory monitoring with auto-kill on resource limits |

### New Apps

| # | Document | Summary |
|---|----------|---------|
| 007 | [VS Code Extension](./007-vscode-extension.md) | Editor integration via daemon/app HTTP APIs |
| 008 | [MCP Server](./008-mcp-server.md) | Expose Kraken as an MCP tool provider for external agents |

### Daemon Features

| # | Document | Summary |
|---|----------|---------|
| 009 | [Workflow / Pipeline Engine](./009-workflow-pipeline-engine.md) | Multi-step task pipelines with dependencies and conditional execution |

### Agent Loop Improvements

| # | Document | Summary |
|---|----------|---------|
| 024 | [Question Tool](./024-question-tool.md) | Interactive question prompts with selectable options during agent execution |
| 025 | [TodoWrite Tool](./025-todowrite-tool.md) | Task list management for tracking progress during complex operations |

### Security & Observability

| # | Document | Summary |
|---|----------|---------|
| 015 | [Telemetry Dashboard](./015-telemetry-dashboard.md) | Metrics collection, cost tracking, Prometheus export |
| 017 | [Sandboxing](./017-sandboxing.md) | Restricted execution environment for bash commands |

### Developer Experience

| # | Document | Summary |
|---|----------|---------|
| 021 | [`kraken replay`](./021-task-replay.md) | Re-execute tasks with same or modified parameters |
| 022 | [`kraken watch --test`](./022-watch-test-mode.md) | Auto-fix test failures on file changes |
| 023 | [Custom Tool Plugins](./023-custom-tool-plugins.md) | User-defined tools via `~/.kraken/tools/` |

## Suggested Implementation Order

```
Phase 1 — Foundation                    ✅ ALL DONE
Phase 2 — Agent Improvements            ✅ MOSTLY DONE (024, 025 remaining)
Phase 3 — Channels & Mobile             ✅ ALL DONE (Telegram, Discord, slash commands, /task, multi-repo, cost tracking)

Phase 4 — Rust Code Intelligence
  001 Tree-sitter AST           (foundation for 002, 003, 004)
  002 Code Search Index         (depends on 001 optionally)
  003 Dependency Graph          (depends on 001)

Phase 5 — Ecosystem
  008 MCP Server                (ecosystem integration)
  023 Custom Tool Plugins       (extensibility)
  009 Workflow Engine           (automation)
  007 VS Code Extension         (editor integration)

Phase 6 — Advanced
  004 Embedding Store           (depends on 001 optionally)
  005 Unified Storage           (migration complexity)
  006 Worker Health Monitoring  (operational maturity)
  015 Telemetry Dashboard       (operational maturity)
  017 Sandboxing                (security hardening)
  021 Task Replay               (small, standalone)
  022 Watch-Test Mode           (combines watchers + agent)
  024 Question Tool             (interactive prompts)
  025 TodoWrite Tool            (task tracking)
```

Each document includes: summary, motivation, current state analysis, architecture with code examples, configuration, HTTP API endpoints, CLI commands, and dependencies on other roadmap items.
