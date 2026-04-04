---
name: notifications
description: Configure and test notification channels -- Slack, Discord, Email, GitHub, and system notifications
---

Notification channels live in `~/.kraken/kraken.jsonc` under `notifications.channels`. Use `read` to inspect and `edit` to modify. After changes, reload the daemon:

```bash
kill -HUP $(cat ~/.kraken/daemon.pid)
```

## Channel Configuration

```json
{
  "notifications": {
    "channels": [
      {
        "name": "unique-channel-name",
        "provider": "slack",
        "webhookUrl": "${SLACK_WEBHOOK_URL}",
        "events": ["task.completed", "task.failed"]
      }
    ]
  }
}
```

Each channel subscribes to specific events. Multiple channels can subscribe to the same event for fan-out (e.g., Slack for instant alerts + email for daily digest).

## Events

| Event | When it fires |
|---|---|
| `task.started` | Worker process spawned for a task |
| `task.completed` | Task finished successfully (exit code 0) |
| `task.failed` | Task failed after all retries exhausted |
| `pr.created` | Worker created a pull request |
| `trigger.fired` | A trigger matched an event and created a task |
| `daily_digest` | Automatic daily summary (every 24h) |
| `cost.warning` | Daily LLM spend exceeded `costs.costWarningThresholdUsd` |

## Providers

### Slack

Uses incoming webhooks. Create one at https://api.slack.com/messaging/webhooks

```json
{
  "name": "slack-alerts",
  "provider": "slack",
  "webhookUrl": "${SLACK_WEBHOOK_URL}",
  "events": ["task.completed", "task.failed", "daily_digest"]
}
```

Store the webhook URL in `~/.kraken/.env`:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx
```

### Discord

Uses Discord webhooks. Create one in Server Settings > Integrations > Webhooks.

```json
{
  "name": "discord-updates",
  "provider": "discord",
  "webhookUrl": "${DISCORD_WEBHOOK_URL}",
  "events": ["task.completed", "task.failed"]
}
```

### Email (via Resend)

Sends email using the Resend API. Get an API key at https://resend.com

```json
{
  "name": "email-alerts",
  "provider": "email",
  "apiKey": "${RESEND_API_KEY}",
  "from": "kraken@yourdomain.com",
  "to": "team@yourdomain.com",
  "events": ["task.failed", "cost.warning"]
}
```

The `from` address must be a verified domain in Resend.

### GitHub

Posts comments on issues or PRs via the GitHub API.

```json
{
  "name": "github-comments",
  "provider": "github",
  "token": "${GITHUB_TOKEN}",
  "repo": "owner/repo",
  "events": ["pr.created"]
}
```

The token needs `repo` scope. Store in `~/.kraken/.env`:

```bash
GITHUB_TOKEN=ghp_...
```

### System (OS notifications)

Desktop notifications via macOS Notification Center or Linux `notify-send`. No configuration needed beyond the channel definition.

```json
{
  "name": "desktop",
  "provider": "system",
  "events": ["task.completed", "task.failed"]
}
```

## Multi-Channel Setup

A common pattern: fast alerts via Slack, detailed summaries via email, desktop for local dev.

```json
{
  "notifications": {
    "channels": [
      {
        "name": "slack-failures",
        "provider": "slack",
        "webhookUrl": "${SLACK_WEBHOOK_URL}",
        "events": ["task.failed", "cost.warning"]
      },
      {
        "name": "email-digest",
        "provider": "email",
        "apiKey": "${RESEND_API_KEY}",
        "from": "kraken@yourdomain.com",
        "to": "team@yourdomain.com",
        "events": ["daily_digest"]
      },
      {
        "name": "desktop",
        "provider": "system",
        "events": ["task.completed", "task.failed"]
      }
    ]
  }
}
```

## Cost Warnings

Enable cost warnings by setting a daily threshold in `~/.kraken/kraken.jsonc`:

```json
{
  "costs": {
    "costWarningThresholdUsd": 10.00
  }
}
```

When daily LLM spend exceeds this amount, a `cost.warning` event fires once per day to all channels subscribed to it.

## Testing

List configured channels:

```bash
kraken notification list
```

Send a test notification to a specific channel:

```bash
kraken notification test <channel-name> --message "Test from Kraken"
```

Verify from the daemon status:

```bash
curl -s http://localhost:50051/api/status | jq '.notifications'
```

## Storing Secrets

All sensitive values (webhook URLs, API keys, tokens) should go in `~/.kraken/.env`, not directly in `kraken.jsonc`. Reference them with `${VAR_NAME}` syntax:

```bash
# ~/.kraken/.env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
RESEND_API_KEY=re_...
GITHUB_TOKEN=ghp_...
```
