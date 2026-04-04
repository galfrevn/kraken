# Kraken Roadmap

This directory contains detailed implementation specifications for planned features. Each document is designed to be self-contained — an LLM or developer can pick up any document and implement the feature with full context.

## Documents

### Rust Optimizations (Move to Daemon)

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
| ~~010~~ | ~~Hot Config Reload~~ | **Done** — HTTP reload endpoint, file watcher with debounce, config validation + diff |

### Agent Loop Improvements

| # | Document | Summary |
|---|----------|---------|
| ~~011~~ | ~~Sub-Agents & Per-Agent Model Routing~~ | **Done** — Sub-agent system with child sessions, per-agent models, explore/general agents, Tab agent switching, per-agent colors |
| ~~012~~ | ~~Context Window Management~~ | **Done** — `manageContextWindow()` with extractive summary, tool result truncation, token estimation |
| ~~013~~ | ~~Persistent Memory~~ | **Done** — `memory_save`, `memory_search`, `memory_context` tools, daemon Memory API, SQLite storage |
| ~~014~~ | ~~Tool Result Caching~~ | **Done** — FileCache + ToolResultCache with mtime validation, LRU eviction, write-time invalidation |
| ~~019~~ | ~~Streaming Improvements~~ | **Done** — Live bash stdout streaming via Bus events, TUI live output rendering |
| 024 | [Question Tool](./024-question-tool.md) | Interactive question prompts with selectable options during agent execution |
| 025 | [TodoWrite Tool](./025-todowrite-tool.md) | Task list management for tracking progress during complex operations |

### Security & Observability

| # | Document | Summary |
|---|----------|---------|
| 015 | [Telemetry Dashboard](./015-telemetry-dashboard.md) | Metrics collection, cost tracking, Prometheus export |
| ~~016~~ | ~~Audit Log~~ | **Done** — separate audit.db, AuditStore, HTTP API, SDK, CLI |
| 017 | [Sandboxing](./017-sandboxing.md) | Restricted execution environment for bash commands |
| ~~018~~ | ~~Rate Limiting~~ | **Done** — RateLimiter, LoopDetector, per-session tool limits |

### Developer Experience

| # | Document | Summary |
|---|----------|---------|
| ~~020~~ | ~~`kraken doctor`~~ | **Done** — diagnostic checks, auto-fix, JSON output |
| 021 | [`kraken replay`](./021-task-replay.md) | Re-execute tasks with same or modified parameters |
| 022 | [`kraken watch --test`](./022-watch-test-mode.md) | Auto-fix test failures on file changes |
| 023 | [Custom Tool Plugins](./023-custom-tool-plugins.md) | User-defined tools via `~/.kraken/tools/` |

## Suggested Implementation Order

```
Phase 1 — Foundation
  010 Hot Config Reload         ✅ DONE
  020 kraken doctor             ✅ DONE
  016 Audit Log                 ✅ DONE
  018 Rate Limiting             ✅ DONE

Phase 2 — Rust Code Intelligence
  001 Tree-sitter AST           (foundation for 002, 003, 004)
  002 Code Search Index         (depends on 001 optionally)
  003 Dependency Graph          (depends on 001)

Phase 3 — Agent Improvements
  011 Sub-Agents + Model Routing ✅ DONE
  014 Tool Result Caching       ✅ DONE
  012 Context Window Management ✅ DONE
  013 Persistent Memory         ✅ DONE
  019 Streaming Improvements    ✅ DONE
  024 Question Tool             (interactive user questions)
  025 TodoWrite Tool            (task tracking)

Phase 4 — Ecosystem
  008 MCP Server                (ecosystem integration)
  023 Custom Tool Plugins       (extensibility)
  009 Workflow Engine           (automation)
  007 VS Code Extension         (editor integration)

Phase 5 — Advanced
  004 Embedding Store           (depends on 001 optionally)
  005 Unified Storage           (migration complexity)
  006 Worker Health Monitoring  (operational maturity)
  015 Telemetry Dashboard       (operational maturity)
  017 Sandboxing                (security hardening)
  021 Task Replay               (small, standalone)
  022 Watch-Test Mode           (combines watchers + agent)
```

Each document includes: summary, motivation, current state analysis, architecture with code examples, configuration, HTTP API endpoints, CLI commands, and dependencies on other roadmap items.
