# Configuration

Kraken uses a layered configuration system. Values load in order, with later sources overriding earlier ones:

1. `~/.kraken/.env` — API keys and secrets
2. `~/.kraken/kraken.jsonc` — Main configuration
3. Environment variables — Runtime overrides

---

## kraken.jsonc

### Top-level structure

```jsonc
{
  "databasePath": "~/.kraken/data/kraken.db",
  "languageModel": { ... },
  "orchestrator": { ... },
  "services": { ... },
  "git": { ... },
  "triggers": { ... },
  "notifications": { ... },
  "mcp": { ... },
  "costs": { ... }
}
```

An empty `{}` config is valid — everything uses sensible defaults.

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
| `heartbeatTimeoutSeconds` | integer | `300` | Kill workers that stop heartbeating after this |
| `retry.maxRetries` | integer | `2` | Times to retry a failed task |
| `retry.backoffSeconds` | integer | `30` | Seconds between retries |

---

### `services`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `daemonPort` | integer | `50051` | Daemon HTTP API port |
| `webhookPort` | integer | `50052` | Webhook ingestion server port |

---

### `git`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `branchPrefix` | string | `"kraken/"` | Prefix for branches created by workers |

---

### `costs`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `costWarningThresholdUsd` | float | `null` | Daily spend threshold for cost warning notifications |

---

## API keys

`~/.kraken/.env` stores sensitive values outside the config file:

```bash
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=whsec_...
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
RESEND_API_KEY=re_...
```

Values in `kraken.jsonc` can reference these with `${VAR_NAME}` syntax. The daemon substitutes them at load time.

---

## Environment variable overrides

| Variable | Overrides | Description |
| --- | --- | --- |
| `KRAKEN_CONFIG_PATH` | Config path | Path to `kraken.jsonc` |
| `DAEMON_PORT` | `services.daemonPort` | Daemon HTTP API port |
| `KRAKEN_PROVIDER` | `languageModel.provider` | LLM provider (app) |
| `KRAKEN_MODEL` | `languageModel.model` | Model (app) |
| `KRAKEN_DAEMON_URL` | Daemon URL | Full daemon URL override (app) |
| `DOTENV_PATH` | `.env` path | Override `~/.kraken/.env` location |

---

## Example: full VPS setup

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
    "retry": { "maxRetries": 3, "backoffSeconds": 60 }
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
            "filter": ["action equals 'opened'"],
            "task": "Review PR #{{event.pull_request.number}}: {{event.pull_request.title}}"
          }
        ]
      }
    ]
  },
  "notifications": {
    "channels": [
      {
        "name": "team-slack",
        "provider": "slack",
        "webhookUrl": "${SLACK_WEBHOOK_URL}",
        "events": ["task.completed", "task.failed", "daily_digest"]
      }
    ]
  },
  "costs": { "costWarningThresholdUsd": 25.00 }
}
```
