# HTTP API

The daemon exposes a REST API on `http://localhost:50051`.

---

## Health and status

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | `{"status": "ok"}` |
| `GET` | `/api/status` | PID, uptime, workers, task counts |
| `POST` | `/api/shutdown` | Trigger graceful shutdown |

---

## Tasks

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/schedule` | Create a task |
| `GET` | `/api/tasks` | List tasks (`?status=`, `?limit=`, `?offset=`) |
| `GET` | `/api/tasks/{id}` | Get task details (supports ID prefix) |
| `POST` | `/api/tasks/{id}/cancel` | Cancel a task |
| `POST` | `/api/tasks/{id}/retry` | Retry a failed task |
| `GET` | `/api/tasks/{id}/logs` | Get task log entries |
| `POST` | `/api/tasks/{id}/heartbeat` | Record worker heartbeat |
| `POST` | `/api/tasks/{id}/usage` | Report token usage |
| `POST` | `/api/tasks/{id}/result` | Save worker output |

### Schedule a task

```
POST /api/schedule
```

```json
{
  "prompt": "Run the test suite and fix failures",
  "priority": 5,
  "agent": "build",
  "workdir": "/path/to/repo"
}
```

```json
{
  "task_id": "a1b2c3d4-...",
  "status": "scheduled"
}
```

---

## Config and secrets

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/config` | Current config (secrets redacted) |
| `GET` | `/api/secrets` | List secret key names |
| `POST` | `/api/secrets` | Set a secret (`key`, `value`) |
| `DELETE` | `/api/secrets/{key}` | Delete a secret |

---

## Stats

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/stats` | Usage statistics (`?period=today\|week\|month`) |
| `POST` | `/api/clean` | Clean old tasks |

---

## Task lifecycle

```
[created] → Pending → Running → Completed
                  ↘         ↘
               Cancelled   Failed → Pending (retry)
```

Workers exit with code 0 on success and 1 on error. The daemon maps exit codes to task status. Failed tasks retry up to `maxRetries` times with `backoffSeconds` delay between attempts.
