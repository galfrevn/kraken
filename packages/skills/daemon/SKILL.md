---
name: daemon
description: Manage the Kraken daemon -- view status, manage tasks, and perform maintenance
---

Use `bash` with `curl` to interact with the daemon HTTP API at `http://localhost:50051`.

For trigger configuration, load the `triggers` skill. For notification setup, load the `notifications` skill.

## Tasks

```bash
curl -s http://localhost:50051/api/tasks?status=all&limit=20 | jq

curl -s http://localhost:50051/api/tasks/{task_id} | jq

curl -s -X POST http://localhost:50051/api/schedule \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Run tests and fix failures", "priority": 5, "agent": "build"}'

curl -s -X POST http://localhost:50051/api/tasks/{task_id}/cancel

curl -s -X POST http://localhost:50051/api/tasks/{task_id}/retry

curl -s http://localhost:50051/api/tasks/{task_id}/logs | jq
```

## Status & Stats

```bash
curl -s http://localhost:50051/api/status | jq

curl -s "http://localhost:50051/api/stats?period=today" | jq

curl -s http://localhost:50051/api/health
```

## Maintenance

```bash
curl -s -X POST http://localhost:50051/api/clean \
  -H "Content-Type: application/json" \
  -d '{"worktrees": true, "task_days": 30, "dry_run": false}'
```

## Configuration

The daemon configuration lives at `~/.kraken/kraken.jsonc`. Use `read` to view and `edit` to modify.

After editing, reload without restarting:

```bash
kill -HUP $(cat ~/.kraken/daemon.pid)
```
