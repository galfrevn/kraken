# Notifications

Kraken sends notifications when tasks complete, fail, or when cost thresholds are exceeded. Configure them in `kraken.jsonc` under the `notifications` key.

---

## Configuration

```jsonc
{
  "notifications": {
    "channels": [
      {
        "name": "team-slack",
        "provider": "slack",
        "webhookUrl": "${SLACK_WEBHOOK_URL}",
        "events": ["task.completed", "task.failed"]
      }
    ]
  }
}
```

---

## Providers

### Slack

Posts messages via incoming webhook with Slack block kit formatting.

```jsonc
{ "name": "alerts", "provider": "slack", "webhookUrl": "${SLACK_WEBHOOK_URL}", "events": [...] }
```

### Discord

Posts messages via webhook.

```jsonc
{ "name": "updates", "provider": "discord", "webhookUrl": "${DISCORD_WEBHOOK_URL}", "events": [...] }
```

### Email (Resend)

Sends email via the Resend API.

```jsonc
{ "name": "email", "provider": "email", "apiKey": "${RESEND_API_KEY}", "from": "kraken@example.com", "to": "team@example.com", "events": [...] }
```

### GitHub

Posts comments on issues and PRs.

```jsonc
{ "name": "github", "provider": "github", "token": "${GITHUB_TOKEN}", "repo": "owner/repo", "events": [...] }
```

### System

OS-native desktop notifications. No additional config needed.

```jsonc
{ "name": "desktop", "provider": "system", "events": [...] }
```

---

## Events

| Event | When |
| --- | --- |
| `task.started` | Worker process spawned |
| `task.completed` | Task finished successfully |
| `task.failed` | Task failed after all retries |
| `pr.created` | Worker created a pull request |
| `trigger.fired` | A trigger matched an event |
| `daily_digest` | Daily summary (every 24h) |
| `cost.warning` | Daily spend exceeded threshold |
