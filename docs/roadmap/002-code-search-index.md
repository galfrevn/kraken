# Persistent Code Search Index in Rust

## Summary

Replace the current approach of spawning `rg` (ripgrep) as a subprocess for every search with a persistent, in-memory inverted index maintained by the daemon. The daemon already runs continuously and has file watchers — it can keep the index updated in real-time and serve sub-millisecond searches via HTTP.

## Motivation

The current `grep` tool in `apps/app/src/tool/grep.ts` spawns a new `rg` process for each search, scanning the filesystem every time. For large repos this adds latency. Since the daemon is a long-running process with file watchers already wired up, maintaining a search index in memory is a natural optimization.

## Current State

- `apps/app/src/tool/grep.ts` spawns `rg` via `Bun.spawn`, caps at 100 matches, returns line-numbered results.
- The daemon has file watchers (`src/watcher.rs`) using the `notify` crate.
- No indexing or caching of file contents exists in the daemon.

## Architecture

### New Daemon Module: `src/search/`

```
src/search/
  mod.rs          -- public API
  index.rs        -- inverted index (term → file:line mappings)
  tokenizer.rs    -- code-aware tokenization (camelCase splitting, snake_case splitting)
  scanner.rs      -- initial repo scan, incremental updates
```

### Core Design

```rust
pub struct SearchIndex {
    trigram_index: DashMap<[u8; 3], Vec<FilePosition>>,
    file_contents: DashMap<PathBuf, Arc<FileEntry>>,
    total_files: AtomicUsize,
}

pub struct FileEntry {
    path: PathBuf,
    content: String,
    last_modified: SystemTime,
    line_offsets: Vec<usize>,  // byte offset of each line start
}

pub struct FilePosition {
    file_id: u32,
    line: u32,
}

pub struct SearchResult {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub content: String,     // the matching line
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}
```

### Search Strategy

1. **Trigram index** for fast candidate filtering (same approach as Google Code Search / Zoekt).
2. **Regex matching** on candidates only — not the whole repo.
3. **File watcher integration**: subscribe to the same `broadcast` channel as triggers. On file change → update that file's entry and trigram postings. On delete → remove.

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | `GET` | Search with `?q=pattern&regex=true&glob=*.ts&limit=50&context=3` |
| `/api/search/files` | `GET` | Search file paths only (fast glob) |
| `/api/search/stats` | `GET` | Index stats: file count, index size, last updated |
| `/api/search/reindex` | `POST` | Force full reindex |

### App Integration

Modify `apps/app/src/tool/grep.ts` to call the daemon's search API when available, falling back to `rg` subprocess when the daemon is not running:

```typescript
async function searchViaIndex(args: GrepArgs, config: Config): Promise<ToolResult> {
  try {
    const params = new URLSearchParams({ q: args.pattern, limit: "100" });
    if (args.path) params.set("path", args.path);
    const response = await fetch(`${config.daemonUrl}/api/search?${params}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("index unavailable");
    return { title: "Search results", content: formatResults(await response.json()) };
  } catch {
    return searchViaRipgrep(args); // existing implementation
  }
}
```

## Incremental Updates

```rust
impl SearchIndex {
    pub fn handle_file_event(&self, event: FileEvent) {
        match event.kind {
            EventKind::Create | EventKind::Modify => {
                if let Ok(content) = std::fs::read_to_string(&event.path) {
                    self.remove_file(&event.path);
                    self.index_file(event.path, content);
                }
            }
            EventKind::Remove => {
                self.remove_file(&event.path);
            }
        }
    }
}
```

## Configuration

Add to `DaemonConfig`:

```rust
pub struct SearchConfig {
    pub enabled: bool,                    // default: true
    pub index_on_startup: bool,           // default: true
    pub ignore_patterns: Vec<String>,     // default: same as .gitignore + node_modules, .git, target, dist
    pub max_file_size_bytes: usize,       // default: 524_288 (512KB)
    pub max_results: usize,              // default: 200
}
```

## Rust Dependencies

```toml
[dependencies]
dashmap = "6"    # already in use
regex = "1"      # already in use
```

No new crates needed — trigram indexing can be implemented with `DashMap` and standard collections.

## Performance Targets

- Initial indexing of 10k files: < 5 seconds.
- Incremental update (single file change): < 10ms.
- Search query: < 50ms for most patterns on a 10k-file repo.
- Memory: ~2x the raw file sizes (content + index). Configurable cap with LRU eviction for content.

## Dependencies on Other Roadmap Items

- **Tree-sitter AST** (001): Symbol-aware search ("find all function definitions matching X") combines the trigram index with AST data.
- **Codebase graph** (003): Search results can be enriched with dependency context.
