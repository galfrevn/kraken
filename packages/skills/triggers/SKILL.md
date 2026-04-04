---
name: triggers
description: Create, modify, and debug triggers -- cron jobs, webhooks, file watchers, CI failure handlers, PR mentions, and slash commands
slash: triggers
aliases: cron, webhooks
---

Triggers live in `~/.kraken/kraken.jsonc` under the `triggers` key. Use `read` to inspect the current config and `edit` to modify it. After any change, reload the daemon with:

```bash
kill -HUP $(cat ~/.kraken/daemon.pid)
```

Verify triggers loaded correctly:

```bash
curl -s http://localhost:50051/api/status | jq
```

## Cron Triggers

Uses 6-field cron expressions (with seconds): `seconds minutes hours day month weekday`

```json
{
  "triggers": {
    "crons": [
      {
        "name": "unique-name",
        "expression": "0 0 9 * * *",
        "task": "The prompt the agent will execute",
        "branchPrefix": "optional/prefix-"
      }
    ]
  }
}
```

Common expressions:
- `0 0 9 * * *` -- daily at 9:00 AM
- `0 0 9 * * 1-5` -- weekdays at 9:00 AM
- `0 */30 * * * *` -- every 30 minutes
- `0 0 2 * * *` -- daily at 2:00 AM (nightly jobs)
- `0 0 0 * * 0` -- weekly on Sunday at midnight
- `0 0 12 1 * *` -- monthly on the 1st at noon

Test a trigger manually:

```bash
curl -s -X POST http://localhost:50051/api/schedule \
  -H "Content-Type: application/json" \
  -d '{"prompt": "The same prompt from your trigger"}'
```

## Webhook Triggers

Receive HTTP POSTs from GitHub or GitLab. The daemon validates signatures (HMAC-SHA256 for GitHub, token comparison for GitLab).

```json
{
  "triggers": {
    "webhooks": [
      {
        "name": "unique-name",
        "provider": "github",
        "secret": "${GITHUB_WEBHOOK_SECRET}",
        "events": [
          {
            "type": "event.action",
            "filter": ["field operator 'value'"],
            "task": "Prompt with {{event.field}} variables"
          }
        ]
      }
    ]
  }
}
```

### Filter syntax

`<json_path> <operator> '<value>'`

Operators: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `matches` (regex).

Fields use dot notation into the webhook payload: `pull_request.head.ref`, `action`, `repository.full_name`.

### Common GitHub webhook patterns

**PR opened:**
```json
{
  "type": "pull_request",
  "filter": ["action equals 'opened'"],
  "task": "Review PR #{{event.pull_request.number}}: {{event.pull_request.title}}"
}
```

**Push to main:**
```json
{
  "type": "push",
  "filter": ["ref equals 'refs/heads/main'"],
  "task": "Run tests after push to main by {{event.pusher.name}}"
}
```

**Issue labeled:**
```json
{
  "type": "issues",
  "filter": ["action equals 'labeled'", "label.name equals 'kraken'"],
  "task": "Investigate issue #{{event.issue.number}}: {{event.issue.title}}"
}
```

**PR review requested:**
```json
{
  "type": "pull_request",
  "filter": ["action equals 'review_requested'"],
  "task": "Review PR #{{event.pull_request.number}} as requested"
}
```

### Template variables

Use `{{event.path.to.field}}` to inject webhook payload values into task prompts. Nested fields use dots. Missing fields resolve to empty strings. Values truncate at 500 characters.

## File Watcher Triggers

Monitor directories for file changes using OS-native events.

```json
{
  "triggers": {
    "watchers": [
      {
        "name": "unique-name",
        "paths": ["./src", "./lib"],
        "ignore": ["node_modules", ".git", "dist", "*.tmp"],
        "debounceMs": 500,
        "task": "File changed at {{event.path}}, review and fix issues"
      }
    ]
  }
}
```

`debounceMs` prevents rapid-fire triggers during saves. Default is 300ms. Use 500-1000ms for large projects.

## CI Failure Triggers (Sugar)

Shorthand that expands into a GitHub `check_suite.completed` webhook with a failure filter:

```json
{
  "triggers": {
    "ci_failures": [
      {
        "name": "unique-name",
        "repo": "owner/repo",
        "branches": ["main", "develop"],
        "task": "CI failed on {{event.repository.full_name}}, investigate and fix"
      }
    ]
  }
}
```

Requires the GitHub webhook to be configured to send `check_suite` events.

## PR Mention Triggers (Sugar)

Shorthand that expands into a GitHub `pull_request_review_comment.created` webhook filtered by a mention keyword:

```json
{
  "triggers": {
    "pr_mentions": [
      {
        "name": "unique-name",
        "repo": "owner/repo",
        "mention": "@kraken",
        "task": "Respond to PR mention: {{event.comment.body}}"
      }
    ]
  }
}
```

## Slash Command Triggers

Listen for mentions in Slack or Discord channels:

```json
{
  "triggers": {
    "slash_commands": [
      {
        "name": "unique-name",
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

For Slack: requires a Socket Mode app with `app_mentions:read` scope. `token` is the Bot Token (xoxb-), `appToken` is the App-Level Token (xapp-).

For Discord: `token` is the Bot Token. The bot must be invited to the channel.

## Debugging

List all configured triggers:

```bash
kraken trigger list
```

Test a specific trigger by name:

```bash
kraken trigger test <trigger-name>
```
