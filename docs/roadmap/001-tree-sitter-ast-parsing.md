# Tree-sitter AST Parsing in Rust

## Summary

Add a tree-sitter-based code parsing service to the Rust daemon. This gives the agent structural understanding of source code (functions, classes, imports, exports, scopes) without depending on an external LSP. The daemon already runs persistently and has file watchers — it can maintain parsed ASTs in memory and serve them on demand.

## Motivation

Today the agent understands code as flat text. Tools like `grep` and `read` return lines, but the agent has no way to ask "what functions does this file export?" or "what are the parameters of this function?" without reading the entire file and inferring from raw text. Tree-sitter parsing in Rust is extremely fast (microseconds per file) and supports 200+ languages.

## Current State

- The daemon has **no** tree-sitter, AST, or code analysis dependencies (`Cargo.toml`).
- File watchers already exist in `src/watcher.rs` using the `notify` crate with debouncing.
- The HTTP API (`src/http_api.rs`) uses Axum and can be extended with new endpoints.
- No code indexing or structural analysis exists anywhere in the project.

## Architecture

### New Daemon Module: `src/code_analysis/`

```
src/code_analysis/
  mod.rs          -- public API, module declarations
  parser.rs       -- tree-sitter parsing, language detection
  index.rs        -- in-memory AST cache, file-to-symbols map
  symbols.rs      -- symbol types (Function, Class, Import, Export, etc.)
  queries.rs      -- tree-sitter query patterns per language
```

### New Rust Dependencies

```toml
[dependencies]
tree-sitter = "0.24"
tree-sitter-typescript = "0.24"
tree-sitter-javascript = "0.24"
tree-sitter-rust = "0.24"
tree-sitter-python = "0.24"
tree-sitter-go = "0.24"
# Add more languages as needed
```

### Data Model

```rust
pub struct FileSymbols {
    pub path: String,
    pub language: String,
    pub last_modified: SystemTime,
    pub symbols: Vec<Symbol>,
}

pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,       // Function, Class, Struct, Enum, Interface, Import, Export, Variable, Constant
    pub start_line: usize,
    pub end_line: usize,
    pub signature: String,      // e.g. "async function fetchData(url: string): Promise<Response>"
    pub children: Vec<Symbol>,  // nested symbols (methods inside a class)
    pub visibility: Option<String>, // pub, export, private, etc.
}
```

### In-Memory Cache

```rust
pub struct CodeIndex {
    files: DashMap<PathBuf, FileSymbols>,
    parsers: Mutex<HashMap<String, tree_sitter::Parser>>,
}
```

- On daemon startup, optionally do an initial scan of `config.repo` (configurable: `codeAnalysis.indexOnStartup: true`).
- File watcher events update the index incrementally — only re-parse changed files.
- Cache invalidation: when a file is modified, remove the old entry and re-parse. When a file is deleted, remove the entry.

### HTTP API Endpoints

Add to `src/http_api.rs`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/symbols` | `GET` | List all indexed files with symbol counts |
| `/api/symbols/{path}` | `GET` | Get symbols for a specific file |
| `/api/symbols/search` | `GET` | Search symbols by name, kind, or pattern (`?name=fetch&kind=function`) |
| `/api/parse` | `POST` | Parse raw source code on-the-fly (body: `{ code, language }`) |
| `/api/outline/{path}` | `GET` | Get a compact outline (signatures only, no bodies) |

### App Integration

Add a new tool `code_symbols` in `apps/app/src/tool/`:

```typescript
// tool/symbols.ts
export const symbolsTool = defineTool({
  id: "code_symbols",
  description: "Get structural information about a file: functions, classes, imports, exports with line numbers and signatures.",
  parameters: z.object({
    path: z.string().describe("File path relative to repo root"),
    kind: z.string().optional().describe("Filter by symbol kind: function, class, import, export, etc."),
  }),
  execute: async (args, context) => {
    const config = loadConfig();
    const response = await fetch(`${config.daemonUrl}/api/symbols/${encodeURIComponent(args.path)}${args.kind ? `?kind=${args.kind}` : ""}`);
    const symbols = await response.json();
    return { title: `Symbols: ${args.path}`, content: formatSymbols(symbols) };
  },
});
```

## Integration with File Watchers

The daemon's existing `FileWatcherEngine` in `src/watcher.rs` broadcasts file change events on a `tokio::sync::broadcast` channel. The `CodeIndex` should subscribe to this same channel and re-parse files on change. This avoids creating a separate watcher.

```rust
// In run_daemon(), after creating the file watcher engine:
let code_index = Arc::new(CodeIndex::new());
let index_clone = code_index.clone();
let mut watcher_rx = file_watcher_event_sender.subscribe();
tokio::spawn(async move {
    while let Ok(event) = watcher_rx.recv().await {
        index_clone.handle_file_event(event).await;
    }
});
```

## Configuration

Add to `DaemonConfig` in `src/daemon/config.rs`:

```rust
pub struct CodeAnalysisConfig {
    pub enabled: bool,                    // default: true
    pub index_on_startup: bool,           // default: false (lazy indexing)
    pub languages: Vec<String>,           // default: ["typescript", "javascript", "rust", "python", "go"]
    pub ignore_patterns: Vec<String>,     // default: ["node_modules", ".git", "dist", "target", "build"]
    pub max_file_size_bytes: usize,       // default: 1_048_576 (1MB)
}
```

## Performance Considerations

- Tree-sitter parsing is incremental — only re-parse the changed byte ranges. Store the previous `tree_sitter::Tree` for each file.
- For large repos (10k+ files), initial indexing should be background and not block daemon startup.
- Memory: a parsed AST for a 1000-line file is ~50KB. 10k files ≈ 500MB max — configurable cap with LRU eviction.
- Parser instances are not thread-safe — use a pool of parsers per language behind a `Mutex` or create per-task.

## Testing

- Unit tests: parse known TypeScript/Rust files, assert correct symbol extraction.
- Integration test: start daemon, create/modify a file, verify `/api/symbols/{path}` returns updated symbols.
- Benchmark: parse time for repos of varying sizes (100, 1000, 10000 files).

## Dependencies on Other Roadmap Items

- **Code search index** (002): The symbol index can feed into the search index for semantic-aware search.
- **Codebase graph** (003): Symbols (especially imports/exports) are the foundation for building a dependency graph.
