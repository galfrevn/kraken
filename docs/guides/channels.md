# Channels

Channels connect Kraken to messaging platforms. Users can send prompts and receive responses directly in Telegram or Discord.

---

## How it works

1. A message arrives on the platform (Telegram, Discord)
2. The daemon routes it to a channel worker process
3. The worker runs the agent loop and streams the response back
4. The reply appears in the chat

Each channel maintains its own session history per chat. The agent has full access to tools — it can read files, run commands, and create PRs, all from a chat message.

---

## Telegram

```jsonc
{
  "channels": {
    "telegram": {
      "token": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "paired"
    }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `token` | string | Bot token from [@BotFather](https://t.me/BotFather) |
| `dmPolicy` | string | `"open"` (anyone) or `"paired"` (authorized users only) |

### User authorization

With `dmPolicy: "paired"`, users must pair first:

```bash
kraken pairing list telegram          # See pending requests
kraken pairing approve telegram <code>  # Approve a user
kraken users list --channel telegram    # List authorized users
kraken users add telegram <platform_id> # Authorize directly
```

---

## Discord

```jsonc
{
  "channels": {
    "discord": {
      "token": "${DISCORD_BOT_TOKEN}",
      "dmPolicy": "paired",
      "allowedChannels": ["1234567890"]
    }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `token` | string | Bot token from the Discord Developer Portal |
| `dmPolicy` | string | `"open"` or `"paired"` |
| `allowedChannels` | string[] | Channel IDs where the bot responds (optional) |

---

## Managing channels

```bash
kraken channel list               # List configured adapters
kraken channel sessions           # Show active sessions
kraken channel add                # Add a new adapter interactively
kraken channel remove telegram    # Remove an adapter
```
