# Embedding Store & Semantic Search in Rust

## Summary

Implement a vector embedding store in the daemon for semantic code search. The daemon generates embeddings for code chunks, stores them in SQLite, and serves similarity searches via HTTP. This enables the agent to find code by meaning ("where do we handle authentication?") rather than exact text matches.

## Motivation

Text search (grep/ripgrep) requires knowing the exact terms. Semantic search lets the agent find relevant code even when the terminology doesn't match. For example, searching "rate limiting" finds code that uses `throttle`, `debounce`, or `RateLimiter` even if the words "rate limiting" never appear.

## Current State

- No embedding or vector search exists in the project.
- The daemon uses `rusqlite` for SQLite — can store vectors as BLOBs.
- The daemon has an LLM provider router (`src/llm/`) that talks to OpenAI-compatible APIs.
- File watchers can trigger re-embedding on file changes.

## Architecture

### New Daemon Module: `src/embeddings/`

```
src/embeddings/
  mod.rs          -- public API
  chunker.rs      -- split files into semantic chunks (function-level, class-level)
  store.rs        -- SQLite vector storage and retrieval
  provider.rs     -- embedding API calls (OpenAI, local models)
  search.rs       -- similarity search with cosine distance
```

### Chunking Strategy

Don't embed entire files — split into semantic chunks:

1. If tree-sitter AST is available (roadmap 001), chunk by top-level symbols (functions, classes, type definitions).
2. Fallback: sliding window with overlap (e.g., 50 lines with 10-line overlap).
3. Each chunk stores: file path, start line, end line, content hash (for change detection), embedding vector.

```rust
pub struct CodeChunk {
    pub id: String,                  // hash of path + start_line
    pub file_path: PathBuf,
    pub start_line: u32,
    pub end_line: u32,
    pub content: String,
    pub content_hash: String,        // for cache invalidation
    pub symbol_name: Option<String>, // if from AST
    pub symbol_kind: Option<String>,
}

pub struct EmbeddedChunk {
    pub chunk: CodeChunk,
    pub embedding: Vec<f32>,         // typically 1536 or 3072 dimensions
}
```

### SQLite Storage

```sql
CREATE TABLE embeddings (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    symbol_name TEXT,
    symbol_kind TEXT,
    embedding BLOB NOT NULL,          -- f32 array as bytes
    model TEXT NOT NULL,              -- embedding model used
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_embeddings_file ON embeddings(file_path);
CREATE INDEX idx_embeddings_hash ON embeddings(content_hash);
```

### Similarity Search

For repos under 100k chunks, brute-force cosine similarity in Rust is fast enough (< 100ms for 100k 1536-dim vectors). For larger repos, consider:
- SQLite `sqlite-vss` extension
- HNSW index in memory (using the `hnsw` crate)

```rust
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (norm_a * norm_b)
}
```

### Embedding Providers

```rust
pub enum EmbeddingProvider {
    OpenAI { api_key: String, model: String },      // text-embedding-3-small
    Local { endpoint: String, model: String },       // ollama, llamafile, etc.
}
```

Use the existing `reqwest` dependency to call embedding APIs. Batch chunks (up to API limits) for efficiency.

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/semantic-search` | `POST` | `{ query: "...", limit: 10, file_glob: "*.ts" }` → ranked chunks |
| `/api/embeddings/stats` | `GET` | Indexed file count, chunk count, model info |
| `/api/embeddings/reindex` | `POST` | Force full re-embedding (expensive) |
| `/api/embeddings/file/{path}` | `DELETE` | Remove embeddings for a specific file |

### App Integration

New tool `semantic_search` in `apps/app/src/tool/`:

```typescript
export const semanticSearchTool = defineTool({
  id: "semantic_search",
  description: "Search code by meaning. Finds relevant code even when exact terms don't match. Use for questions like 'where do we handle X?' or 'how is Y implemented?'",
  parameters: z.object({
    query: z.string().describe("Natural language query describing what you're looking for"),
    limit: z.number().optional().describe("Max results. Default: 10."),
    glob: z.string().optional().describe("Filter results by file glob pattern"),
  }),
  execute: async (args, context) => {
    const config = loadConfig();
    const response = await fetch(`${config.daemonUrl}/api/semantic-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const results = await response.json();
    return { title: "Semantic search", content: formatSemanticResults(results) };
  },
});
```

## Incremental Updates

- File watcher event → check if any chunks for that file have changed content hashes → only re-embed changed chunks.
- Rate limit embedding API calls to avoid excessive costs (queue with backpressure).
- On daemon startup, compare file modification times against stored `created_at` to find stale embeddings.

## Configuration

```rust
pub struct EmbeddingsConfig {
    pub enabled: bool,                         // default: false (requires API key)
    pub provider: String,                      // "openai" | "local"
    pub model: String,                         // default: "text-embedding-3-small"
    pub api_key_env: String,                   // env var name for API key
    pub local_endpoint: Option<String>,        // for local models
    pub chunk_max_lines: usize,                // default: 100
    pub chunk_overlap_lines: usize,            // default: 10
    pub batch_size: usize,                     // default: 50
    pub max_concurrent_requests: usize,        // default: 3
    pub ignore_patterns: Vec<String>,          // default: same as search config
}
```

## Cost Considerations

- `text-embedding-3-small`: ~$0.02 per 1M tokens. A 10k-file repo with ~50k chunks ≈ $0.10 for initial indexing.
- Incremental updates are cheap — only re-embed changed chunks.
- Local models (via Ollama) have zero API cost but require GPU.

## Dependencies on Other Roadmap Items

- **Tree-sitter AST** (001): Enables function-level chunking instead of sliding window. Strongly recommended but not required.
- **Code search index** (002): Text search and semantic search complement each other — combine results for best coverage.
