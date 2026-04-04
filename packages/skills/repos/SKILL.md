---
name: repos
description: Configure and manage multiple repositories for Kraken to work across different codebases
---

Repos are configured in `~/.kraken/kraken.jsonc` under the `repos` key. Use `read` to inspect the current config and `edit` to modify it. After any change, reload the daemon:

```bash
kill -HUP $(cat ~/.kraken/daemon.pid)
```

## Configuration

```json
{
  "repos": [
    { "name": "frontend", "path": "~/code/frontend", "default": true },
    { "name": "api", "path": "~/code/api" },
    { "name": "infra", "path": "~/code/infra" }
  ]
}
```

### Fields

- `name` — Short identifier used in commands and tasks (e.g., "api", "frontend", "infra")
- `path` — Absolute path to the repository. Supports `~/` for home directory.
- `default` — (optional, boolean) If `true`, this repo is used when no `--repo` flag is specified. Only one repo should be default. If none is marked, the first repo in the list is used.

## How repos are used

### From Telegram slash commands

- `/repos` — Lists all configured repos
- `/task fix the login bug` — Creates a task in the **default** repo
- `/task --repo=api add health endpoint` — Creates a task in the "api" repo

### From the TUI schedule tool

The `schedule_task` tool accepts a `workdir` parameter. When a repo is configured, the workdir is resolved from the repo path.

### In background tasks

When a task is created with a repo's path as `workdir`, the orchestrator:
1. Creates an isolated git worktree within that repo
2. Runs the agent in that worktree
3. Cleans up the worktree when done (or after 7 days)

## Adding a repo

To add a new repo, read the current config, then edit the `repos` array:

```bash
# Read current config
cat ~/.kraken/kraken.jsonc
```

Then add the repo entry to the `repos` array. The path must be an existing git repository.

## Verifying repos

```bash
# List repos via CLI (if available)
kraken channel list  # shows channel info; repos shown via /repos command in Telegram

# Or check config directly
cat ~/.kraken/kraken.jsonc | grep -A 5 repos
```

## Common patterns

### Monorepo with multiple services
If your project is a monorepo, you can register subpaths:
```json
{
  "repos": [
    { "name": "monorepo", "path": "~/code/myproject", "default": true },
    { "name": "backend", "path": "~/code/myproject/services/backend" },
    { "name": "frontend", "path": "~/code/myproject/apps/web" }
  ]
}
```

### Multiple independent repos
```json
{
  "repos": [
    { "name": "website", "path": "~/code/website", "default": true },
    { "name": "api", "path": "~/code/api-server" },
    { "name": "mobile", "path": "~/code/mobile-app" },
    { "name": "shared", "path": "~/code/shared-lib" }
  ]
}
```

### Single repo (simplest)
```json
{
  "repos": [
    { "name": "myproject", "path": "~/code/myproject", "default": true }
  ]
}
```

## Important notes

- Paths must point to existing directories (ideally git repositories for worktree support)
- The `~` prefix is expanded to the user's home directory at runtime
- Repo names are case-insensitive when used in `--repo=` flag
- If no repos are configured, tasks use the daemon's working directory
