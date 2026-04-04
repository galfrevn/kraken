# Configuration

Kraken uses a layered configuration system. Values are loaded in order, with later sources overriding earlier ones:

1. **`~/.kraken/.env`** -- API keys and secrets (loaded first)
2. **`~/.kraken/kraken.jsonc`** -- Main configuration (daemon + TUI)
3. **Environment variables** -- Runtime overrides

The `kraken init` wizard generates all of these files during onboarding.

---

## `kraken.jsonc` -- Full Schema Reference

### Top-Level

```jsonc
{
  "databasePath": "~/.kraken/data/kraken.db",

  "languageModel": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4-20250514",
    "temperature": 0.7,
    "maxTokens": 16384
  },

  "orchestrator": {
    "maxConcurrentTasks": 3,
    "heartbeatTimeoutSeconds": 300,
    "retry": {
      "maxRetries": 2,
      "backoffSeconds": 30
    }
  },

  "services": {
    "daemonPort": 50051,
    "webhookPort": 50052
  },

  "git": {
    "branchPrefix": "kraken/"
  },

  "triggers": {
    // ... see Triggers section below
  },

  "notifications": {
    // ... see Notifications section below
  },

  "costs": {
    "costWarningThresholdUsd": 10.00
  }
}
```

---

### `languageModel`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | `"openrouter"` | LLM provider identifier |
| `model` | string | `"anthropic/claude-sonnet-4-20250514"` | Model name |
| `temperature` | float | `0.7` | Sampling temperature |
| `maxTokens` | integer | `16384` | Maximum output tokens |

---

### `orchestrator`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxConcurrentTasks` | integer | `3` | Max worker processes running simultaneously |
| `heartbeatTimeoutSeconds` | integer | `300` | Seconds without heartbeat before killing a worker |
| `retry.maxRetries` | integer | `2` | Times to retry a failed task |
| `retry.backoffSeconds` | integer | `30` | Seconds to wait between retries |

---

### `services`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `daemonPort` | integer | `50051` | Port for the daemon HTTP API |
| `webhookPort` | integer | `50052` | Port for the webhook ingestion server |

---

### `git`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `branchPrefix` | string | `"kraken/"` | Prefix for branches created by workers (e.g., `kraken/fix-login-abcdef12`) |

---

### `costs`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `costWarningThresholdUsd` | float | `null` | Daily spend threshold that triggers a cost warning notification |

---

### `triggers`

#### Cron Triggers

```jsonc
{
  "triggers": {
    "crons": [
      {
        "name": "daily-review",
        "expression": "0 0 9 * * *",
        "task": "Review all open PRs and summarize findings",
        "branchPrefix": "review/" // optional, overrides git.branchPrefix
      }
    ]
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Unique identifier |
| `expression` | string | yes | Cron expression (6-field with seconds) |
| `task` | string | yes | Task prompt template |
| `branchPrefix` | string | no | Override branch prefix for this trigger |

#### Webhook Triggers

```jsonc
{
  "triggers": {
    "webhooks": [
      {
        "name": "github-push",
        "provider": "github",
        "secret": "${GITHUB_WEBHOOK_SECRET}",
        "events": [
          {
            "type": "push",
            "filter": [
              "ref equals 'refs/heads/main'"
            ],
            "task": "Run tests for push to main on {{event.repository.full_name}}"
          }
        ]
      }
    ]
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Unique identifier |
| `provider` | string | yes | `github` or `gitlab` |
| `secret` | string | yes | Webhook secret (supports `${ENV_VAR}` syntax) |
| `events[].type` | string | yes | Event type (e.g., `push`, `pull_request`) |
| `events[].filter` | string[] | no | Filter expressions (see below) |
| `events[].task` | string | yes | Task prompt template with `{{event.xxx}}` variables |

**Filter syntax**: `<field> <operator> '<value>'`

Operators: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `matches` (regex).

Fields use dot notation to navigate the webhook payload (e.g., `pull_request.head.ref`).

#### File Watcher Triggers

```jsonc
{
  "triggers": {
    "watchers": [
      {
        "name": "src-watcher",
        "paths": ["./src", "./lib"],
        "ignore": ["node_modules", ".git", "dist"],
        "debounceMs": 500,
        "task": "File changed: {{event.path}}"
      }
    ]
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Unique identifier |
| `paths` | string[] | yes | Directories to watch |
| `ignore` | string[] | no | Patterns to ignore |
| `debounceMs` | integer | no | Debounce interval in milliseconds (default: 300) |
| `task` | string | yes | Task prompt template |

#### CI Failure Triggers (Sugar)

Shorthand for GitHub `check_suite.completed` webhook with failure filter:

```jsonc
{
  "triggers": {
    "ci_failures": [
      {
        "name": "ci-watch",
        "repo": "owner/repo",
        "branches": ["main", "develop"],
        "task": "CI failed on {{event.repository.full_name}}, investigate and fix"
      }
    ]
  }
}
```

#### PR Mention Triggers (Sugar)

```jsonc
{
  "triggers": {
    "pr_mentions": [
      {
        "name": "pr-watch",
        "repo": "owner/repo",
        "mention": "@kraken",
        "task": "Respond to PR mention: {{event.comment.body}}"
      }
    ]
  }
}
```

#### Slash Command Triggers

Listen for mentions in Slack or Discord channels:

```jsonc
{
  "triggers": {
    "slash_commands": [
      {
        "name": "slack-bot",
        "provider": "slack",
        "token": "${SLACK_BOT_TOKEN}",
        "appToken": "${SLACK_APP_TOKEN}",
        "channel": "#dev",
        "mention": "@kraken",
        "task": "{{event.text}}"
      }
    ]
  }
}
```

---

### `notifications`

```jsonc
{
  "notifications": {
    "channels": [
      {
        "name": "slack-alerts",
        "provider": "slack",
        "webhookUrl": "${SLACK_WEBHOOK_URL}",
        "events": [
          "task.completed",
          "task.failed"
        ]
      },
      {
        "name": "discord-updates",
        "provider": "discord",
        "webhookUrl": "${DISCORD_WEBHOOK_URL}",
        "events": [
          "task.completed"
        ]
      },
      {
        "name": "email-alerts",
        "provider": "email",
        "apiKey": "${RESEND_API_KEY}",
        "from": "kraken@example.com",
        "to": "team@example.com",
        "events": [
          "task.failed",
          "cost.warning"
        ]
      },
      {
        "name": "github-comments",
        "provider": "github",
        "token": "${GITHUB_TOKEN}",
        "repo": "owner/repo",
        "events": [
          "pr.created"
        ]
      },
      {
        "name": "desktop",
        "provider": "system",
        "events": [
          "task.completed",
          "task.failed"
        ]
      }
    ]
  }
}
```

**Available providers**: `slack`, `discord`, `email` (Resend), `github`, `system` (OS notifications).

**Available events**:

| Event | Description |
| --- | --- |
| `task.started` | A task began execution |
| `task.completed` | A task finished successfully |
| `task.failed` | A task failed |
| `pr.created` | A pull request was created by a worker |
| `trigger.fired` | A trigger matched and created a task |
| `daily_digest` | Daily summary (sent every 24h) |
| `cost.warning` | Daily spend exceeded `costWarningThresholdUsd` |

---

### `mcp`

Configure MCP (Model Context Protocol) servers that provide additional tools to the agent:

```jsonc
{
  "mcp": {
    "sqlite-server": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-sqlite", "db.sqlite"],
      "environment": {},
      "enabled": true,
      "timeout": 30000
    },
    "remote-tools": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      },
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | yes | `"local"` (stdio) or `"remote"` (HTTP/SSE) |
| `command` | string[] | local only | Command and arguments to spawn |
| `environment` | object | no | Extra environment variables for the process |
| `url` | string | remote only | URL of the remote MCP server |
| `headers` | object | no | HTTP headers (supports `${ENV_VAR}` syntax) |
| `enabled` | boolean | no | Set to `false` to disable without removing (default: `true`) |
| `timeout` | number | no | Connection timeout in milliseconds (default: 30000) |

MCP tools are automatically merged with built-in tools and available to the agent during conversations and worker execution.

---

## `~/.kraken/.env` -- API Keys

Stores sensitive values outside the config file:

```bash
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=whsec_...
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
RESEND_API_KEY=re_...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Values in `kraken.jsonc` can reference environment variables with `${VAR_NAME}` syntax. The daemon substitutes them at load time.

---

## Environment Variable Overrides

| Variable | Overrides | Description |
| --- | --- | --- |
| `KRAKEN_CONFIGURATION_FILE` | Config file path | Path to `kraken.jsonc` (used by both daemon and app) |
| `KRAKEN_CONFIG_PATH` | Config file path | Alternative to above (daemon only, also via `--config` flag) |
| `DAEMON_PORT` | `services.daemonPort` | Daemon HTTP API port |
| `KRAKEN_PROVIDER` | `languageModel.provider` | LLM provider override (app) |
| `KRAKEN_MODEL` | `languageModel.model` | Model override (app) |
| `KRAKEN_DAEMON_URL` | `services.daemonPort` | Full daemon URL override (app) |
| `KRAKEN_APP_PORT` | App server port | TUI internal server port (default: 7899) |
| `KRAKEN_DAEMON_LOG_FILE` | Daemon log output | Write logs to file instead of stderr |
| `DOTENV_PATH` | `.env` file location | Override the default `~/.kraken/.env` path (daemon only) |

---

## Example: Minimal Setup

```jsonc
{}
```

Everything uses defaults: OpenRouter provider, port 50051, 3 concurrent workers, no triggers, no notifications. Tasks specify their own working directory.

## Example: Full VPS Setup

```jsonc
{
  "languageModel": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "temperature": 0.3
  },

  "orchestrator": {
    "maxConcurrentTasks": 5,
    "heartbeatTimeoutSeconds": 600,
    "retry": {
      "maxRetries": 3,
      "backoffSeconds": 60
    }
  },

  "services": {
    "daemonPort": 50051,
    "webhookPort": 9000
  },

  "triggers": {
    "crons": [
      {
        "name": "nightly-tests",
        "expression": "0 0 2 * * *",
        "task": "Run the full test suite and report failures"
      }
    ],
    "webhooks": [
      {
        "name": "github-prs",
        "provider": "github",
        "secret": "${GITHUB_WEBHOOK_SECRET}",
        "events": [
          {
            "type": "pull_request",
            "filter": [
              "action equals 'opened'"
            ],
            "task": "Review PR #{{event.pull_request.number}}: {{event.pull_request.title}}"
          }
        ]
      }
    ],
    "ci_failures": [
      {
        "name": "ci-fix",
        "repo": "myorg/myproject",
        "branches": ["main"],
        "task": "CI failed, investigate and propose a fix"
      }
    ]
  },

  "notifications": {
    "channels": [
      {
        "name": "team-slack",
        "provider": "slack",
        "webhookUrl": "${SLACK_WEBHOOK_URL}",
        "events": [
          "task.completed",
          "task.failed",
          "daily_digest"
        ]
      }
    ]
  },

  "costs": {
    "costWarningThresholdUsd": 25.00
  }
}
```
