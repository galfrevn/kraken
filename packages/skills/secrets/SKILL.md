---
name: secrets
description: Manage API keys and secrets safely -- list, set, and delete without exposing values
slash: secrets
aliases: keys
---

Secrets are stored in `~/.kraken/.env` and managed exclusively through the daemon API. You MUST NOT read or display secret values. The API only returns key names, never values.

## List secret keys

Returns the names of all configured secrets (values are never exposed):

```bash
curl -s http://localhost:50051/api/secrets | jq
```

Response:
```json
{ "keys": ["OPENROUTER_API_KEY", "GITHUB_WEBHOOK_SECRET", "SLACK_WEBHOOK_URL"] }
```

## Set a secret

```bash
curl -s -X POST http://localhost:50051/api/secrets \
  -H "Content-Type: application/json" \
  -d '{"key": "OPENROUTER_API_KEY", "value": "sk-or-..."}'
```

When the user provides a new API key or secret, use this endpoint. The daemon writes it to `~/.kraken/.env` securely.

## Delete a secret

```bash
curl -s -X DELETE http://localhost:50051/api/secrets/OPENROUTER_API_KEY
```

## Common secret keys

| Key | Used for |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter LLM provider |
| `ANTHROPIC_API_KEY` | Anthropic LLM provider |
| `OPENAI_API_KEY` | OpenAI LLM provider |
| `GITHUB_TOKEN` | GitHub API access (notifications, PR comments) |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification |
| `SLACK_WEBHOOK_URL` | Slack notification channel |
| `SLACK_BOT_TOKEN` | Slack slash command bot |
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `DISCORD_WEBHOOK_URL` | Discord notification channel |
| `RESEND_API_KEY` | Email notifications via Resend |
| `TAVILY_API_KEY` | Web search via Tavily (websearch tool) |

## Security rules

- NEVER read `~/.kraken/.env` directly -- it is blocked at the tool level
- NEVER display, log, or output secret values in the conversation
- When a user says "set my API key to X", use the POST endpoint above
- When a user asks "what keys do I have configured?", use the GET endpoint which only returns key names
