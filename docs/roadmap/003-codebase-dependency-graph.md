# Codebase Dependency Graph in Rust

## Summary

Build a dependency graph of the project in the daemon using import/export analysis. Expose endpoints that answer: "what files does X import?", "what files import X?", "what files are transitively affected by changing X?". This gives the agent impact analysis before making changes.

## Motivation

When the agent modifies a file, it has no way to know what other files depend on it without grep-ing for import statements. A pre-computed dependency graph makes this instant and complete, including transitive dependencies.

## Current State

- No dependency analysis exists in the project.
- Tree-sitter AST parsing (roadmap 001) would provide the import/export data this feature needs.
- File watchers can trigger graph updates on file changes.

## Architecture

### New Daemon Module: `src/graph/`

```
src/graph/
  mod.rs          -- public API
  builder.rs      -- graph construction from imports/exports
  resolver.rs     -- path resolution (relative imports, aliases, index files)
  types.rs        -- graph data structures
```

### Data Model

```rust
pub struct DependencyGraph {
    nodes: DashMap<PathBuf, FileNode>,
    edges: DashMap<PathBuf, Vec<Edge>>,         // outgoing: file → its imports
    reverse_edges: DashMap<PathBuf, Vec<Edge>>,  // incoming: file → who imports it
}

pub struct FileNode {
    pub path: PathBuf,
    pub language: String,
    pub exports: Vec<String>,        // exported symbols
    pub last_updated: SystemTime,
}

pub struct Edge {
    pub source: PathBuf,
    pub target: PathBuf,
    pub import_specifier: String,    // e.g. "@/tool/registry.ts" or "../config"
    pub imported_symbols: Vec<String>, // e.g. ["loadConfig", "resetConfig"]
}
```

### Resolution Rules

The resolver must handle:
- Relative paths (`./foo`, `../bar`)
- TypeScript path aliases (`@/tool/registry.ts` → `src/tool/registry.ts` via tsconfig `paths`)
- Index files (`import from "./config"` → `./config/index.ts`)
- Package imports (`import { z } from "zod"`) — mark as external, don't resolve
- Rust `mod` / `use` declarations
- Python relative and absolute imports

Read `tsconfig.json` `paths` and `baseUrl` for TypeScript resolution. Read `Cargo.toml` for Rust module structure.

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/graph/imports/{path}` | `GET` | Files that `{path}` imports (direct) |
| `/api/graph/importers/{path}` | `GET` | Files that import `{path}` (direct) |
| `/api/graph/affected/{path}` | `GET` | Transitive closure of importers — all files affected by changing `{path}` |
| `/api/graph/stats` | `GET` | Graph stats: node count, edge count, most-imported files |
| `/api/graph/cycles` | `GET` | Detect circular dependencies |
| `/api/graph/rebuild` | `POST` | Force full rebuild |

### App Integration

New tool `impact_analysis` in `apps/app/src/tool/`:

```typescript
export const impactAnalysisTool = defineTool({
  id: "impact_analysis",
  description: "Find all files that would be affected by changing a given file. Returns direct and transitive dependents.",
  parameters: z.object({
    path: z.string().describe("File path relative to repo root"),
    depth: z.number().optional().describe("Max depth of transitive dependencies. Default: unlimited."),
  }),
  execute: async (args, context) => {
    const config = loadConfig();
    const response = await fetch(`${config.daemonUrl}/api/graph/affected/${encodeURIComponent(args.path)}`);
    const affected = await response.json();
    return { title: `Impact: ${args.path}`, content: formatAffectedFiles(affected) };
  },
});
```

## Dependencies on Other Roadmap Items

- **Tree-sitter AST** (001): Required for extracting import/export statements. This feature should be built after 001.
- **Code search index** (002): Can use the graph to rank search results by relevance (files closer in the graph to the current context rank higher).

## Configuration

```rust
pub struct GraphConfig {
    pub enabled: bool,                   // default: true
    pub resolve_aliases: bool,           // default: true (read tsconfig paths)
    pub include_external: bool,          // default: false (skip node_modules imports)
    pub max_depth: Option<usize>,        // default: None (unlimited)
}
```
