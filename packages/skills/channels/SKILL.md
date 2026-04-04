---
name: channels
description: Configure external messaging channel adapters (Telegram, etc.) — saves credentials securely and patches kraken.jsonc
slash: channels
aliases: telegram, discord
---

# Channel Setup Skill

You are configuring a messaging channel adapter so the user can interact with Kraken from an external platform.

## Supported channel types

| Type | Required secrets | Config key |
|---|---|---|
| `telegram` | `TELEGRAM_BOT_TOKEN` | `channels.telegram` |

## Step-by-step: Telegram

### 1. Gather information

Ask the user for:

1. **Bot token** — obtained from [@BotFather](https://t.me/BotFather) on Telegram. Tell the user to message `/newbot` to BotFather and follow the prompts.
2. **Owner ID** — their numeric Telegram user ID. Tell the user to send `/start` to [@userinfobot](https://t.me/userinfobot) to get it.

### 2. Save the bot token securely

Use the daemon secrets API (do NOT edit `~/.kraken/.env` directly — it is blocked at the tool level):

```bash
curl -s -X POST http://localhost:50051/api/secrets \
  -H "Content-Type: application/json" \
  -d '{"key": "TELEGRAM_BOT_TOKEN", "value": "<THE_TOKEN>"}'
```

### 3. Update kraken.jsonc

Read `~/.kraken/kraken.jsonc`, then edit it to add or update the `channels.telegram` section:

```json
{
  "channels": {
    "telegram": {
      "token": "${TELEGRAM_BOT_TOKEN}",
      "ownerId": <OWNER_ID>,
      "enabled": true
    }
  }
}
```

- `token` must reference the env variable with `${TELEGRAM_BOT_TOKEN}`, not the raw token value.
- `ownerId` is the numeric user ID from step 1.
- `enabled` defaults to `true`.

### 4. Reload the daemon

```bash
curl -s -X POST http://localhost:50051/api/config/reload
```

This triggers a live config reload without restarting the daemon. If the daemon is not running, use `kill -HUP $(cat ~/.kraken/daemon.pid)` as a fallback.

### 5. Verify

Run the CLI to confirm the channel appears:

```bash
kraken channel list
```

Expected output should show `telegram` with `enabled: yes`.

## Removing a channel

To remove a configured channel, edit `~/.kraken/kraken.jsonc` and delete the corresponding key under `channels` (e.g., remove `channels.telegram`), then reload the daemon.

## Security rules

- NEVER write the bot token directly into `kraken.jsonc` — always use the `${TELEGRAM_BOT_TOKEN}` env reference.
- NEVER read or display `~/.kraken/.env` — it is blocked at the tool level.
- NEVER echo or log token values in bash commands or conversation output.
- Use the daemon secrets API (`POST /api/secrets`) for all credential storage.
