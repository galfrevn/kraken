# Unified Storage in Rust Daemon

## Summary

Consolidate the two separate SQLite databases (daemon's `rusqlite` task store + app's `bun:sqlite`/Drizzle session store) into a single database managed by the daemon. The app queries session/message data via HTTP endpoints on the daemon instead of maintaining its own database connection.

## Motivation

Having two databases creates problems:
- No cross-referencing between tasks and sessions (a worker runs a task, but the session it creates is in a different DB).
- Two different migration systems (manual `CREATE TABLE` in both places).
- Backup requires copying two files from different locations.
- The daemon can't query conversation history for analytics, daily digests, or context.
- Cleanup (`kraken clean`) only knows about tasks, not sessions.

## Current State

### Daemon Database (`~/.kraken/daemon.db`)

Managed by `apps/daemon/src/db/tasks.rs` via `rusqlite`. Contains:
- `tasks` table: id, name (prompt), status, priority, agent, created_at, started_at, completed_at, exit_code, output, error, retry_count, worktree_path, cost, pr_url.

### App Database (`~/.kraken/data/kraken.db`)

Managed by `apps/app/src/storage/db.ts` via `bun:sqlite` + Drizzle ORM. Contains:
- `session` table: id, title, agentId, model, timeCreated, timeUpdated.
- `message` table: id, sessionId, role, timeCreated.
- `part` table: id, messageId, sessionId, type, content, toolName, toolCallId, toolInput, state, timeCreated.

## Architecture

### Phase 1: Add Session/Message Tables to Daemon DB

Add new tables to `apps/daemon/src/db/`:

```
src/db/
  mod.rs          -- existing: SQLite pool setup
  tasks.rs        -- existing: task CRUD
  sessions.rs     -- new: session CRUD
  messages.rs     -- new: message + part CRUD
  schema.rs       -- new: all CREATE TABLE statements
```

New tables in the daemon's SQLite (matching the app's current schema):

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    agent_id TEXT NOT NULL DEFAULT 'build',
    model TEXT,
    task_id TEXT,                              -- NEW: link to tasks table
    time_created TEXT NOT NULL DEFAULT (datetime('now')),
    time_updated TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    time_created TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'tool-call', 'tool-result', 'reasoning')),
    content TEXT,
    tool_name TEXT,
    tool_call_id TEXT,
    tool_input TEXT,
    state TEXT DEFAULT 'completed' CHECK (state IN ('pending', 'running', 'completed', 'error')),
    time_created TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

Key addition: `sessions.task_id` links a session to the task that spawned it.

### Phase 2: New HTTP API Endpoints

Add to `src/http_api.rs`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions` | `GET` | List sessions with pagination |
| `/api/sessions` | `POST` | Create a new session |
| `/api/sessions/{id}` | `GET` | Get session details |
| `/api/sessions/{id}` | `DELETE` | Delete session and cascade |
| `/api/sessions/{id}/messages` | `GET` | Get messages for a session |
| `/api/sessions/{id}/messages` | `POST` | Add a message to a session |
| `/api/sessions/{id}/messages/{mid}/parts` | `POST` | Add parts (batch) to a message |
| `/api/sessions/{id}/title` | `PUT` | Update session title |

### Phase 3: Migrate App to Use Daemon API

In `apps/app/src/storage/`:

1. Replace direct SQLite calls with HTTP calls to the daemon.
2. Keep a thin cache in-process for the current session's messages (performance).
3. Remove `bun:sqlite` dependency and `storage/db.ts`.
4. Remove the separate `~/.kraken/data/kraken.db` file.

```typescript
// storage/remote.ts — new implementation
export class RemoteSessionStore {
  constructor(private daemonUrl: string) {}

  async createSession(agentId: string, model?: string): Promise<Session> {
    const response = await fetch(`${this.daemonUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, model }),
    });
    return response.json();
  }

  async addMessage(sessionId: string, role: string): Promise<Message> {
    // ...
  }

  async addParts(sessionId: string, messageId: string, parts: Part[]): Promise<void> {
    // batch insert via single HTTP call
  }
}
```

### Phase 4: Migration Tool

A one-time migration that reads the old app DB and inserts records into the daemon DB:

```bash
kraken migrate-storage       # reads ~/.kraken/data/kraken.db → daemon.db
```

## Benefits After Migration

- `kraken stats` can show session/conversation metrics alongside task metrics.
- `kraken clean --sessions-days 30` cleans old sessions.
- Daily digest notifications can include conversation summaries.
- Task → session → messages is a single query join.
- Single backup file: `~/.kraken/daemon.db`.

## Configuration

No new config needed — the existing `database_path` in `DaemonConfig` is used.

## Risks and Mitigations

- **Latency**: HTTP calls add ~1ms per request on localhost. For high-frequency operations (streaming parts), batch inserts mitigate this.
- **Offline mode**: If the daemon is not running, the app can't store sessions. Mitigation: keep a local write-ahead buffer that syncs when the daemon comes back.
- **Migration failures**: The migration tool should be idempotent and report conflicts rather than overwriting.

## Dependencies on Other Roadmap Items

- None — this is independent and can be implemented at any time.
- Benefits the **web dashboard** (not in roadmap) since all data is accessible from one API.
