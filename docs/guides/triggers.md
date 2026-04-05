# Triggers

Triggers react to events and create tasks automatically. Configure them in `kraken.jsonc` under the `triggers` key.

---

## Cron

Scheduled tasks using 6-field cron expressions (with seconds).

```jsonc
{
  "triggers": {
    "crons": [
      {
        "name": "daily-review",
        "expression": "0 0 9 * * *",
        "task": "Review all open PRs and summarize findings",
        "branchPrefix": "review/"
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
| `branchPrefix` | string | no | Override `git.branchPrefix` for this trigger |

---

## File watchers

React to file system changes with configurable debounce.

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
| `debounceMs` | integer | no | Debounce interval in ms (default: 300) |
| `task` | string | yes | Task prompt template |

---

## Webhooks

Receive HTTP POST events from GitHub or GitLab.

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
            "filter": ["ref equals 'refs/heads/main'"],
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
| `secret` | string | yes | Webhook secret (`${ENV_VAR}` syntax supported) |
| `events[].type` | string | yes | Event type (e.g. `push`, `pull_request`) |
| `events[].filter` | string[] | no | Filter expressions |
| `events[].task` | string | yes | Task prompt with `{{event.xxx}}` variables |

### Filter syntax

```
<field> <operator> '<value>'
```

Operators: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `matches` (regex).

Fields use dot notation to navigate the payload: `pull_request.head.ref`.

---

## CI failure triggers

Shorthand for GitHub `check_suite.completed` with failure filtering.

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

---

## PR mention triggers

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

---

## Template variables

Task templates support `{{event.xxx}}` for variable substitution from the event payload. Dot notation navigates nested JSON. Values are truncated at 500 characters. Missing fields resolve to empty strings.

```jsonc
"task": "Review PR #{{event.pull_request.number}}: {{event.pull_request.title}}"
```
