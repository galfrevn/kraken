# CLI Reference

## `kraken` / `kraken start`

Start the interactive TUI with the daemon.

```bash
kraken                          # Start TUI + daemon
kraken start --no-daemon        # TUI only, skip daemon
kraken start --dev              # Development mode with hot reload
kraken -c                       # Resume most recent session
```

---

## `kraken daemon`

Control the background daemon.

```bash
kraken daemon start                     # Start in background
kraken daemon start --port 8080         # Custom port
kraken daemon start --config ./my.jsonc # Custom config
kraken daemon run                       # Foreground (Docker, systemd)
kraken daemon run --log-file /var/log/kraken.log
kraken daemon stop                      # Graceful shutdown
kraken daemon stop --force              # Kill after 5s grace period
kraken daemon status                    # Uptime, workers, task counts
kraken daemon reload                    # Reload config without restart
```

---

## `kraken init`

Setup wizard for LLM provider, API key, triggers, and notifications.

```bash
kraken init                     # Interactive wizard
kraken init --defaults          # Skip prompts, minimal config
```

---

## `kraken task`

```bash
kraken task create "Run the test suite" --priority 8 --agent build
kraken task list --status running --limit 10
kraken task show <task-id>      # Full UUID or 6+ char prefix
kraken task cancel <task-id>
kraken task retry <task-id>
kraken task logs <task-id> --follow
```

---

## `kraken config`

```bash
kraken config show              # Print config (secrets redacted)
kraken config path              # Resolved config file path
kraken config get orchestrator.maxConcurrentTasks
kraken config set orchestrator.maxConcurrentTasks 5
kraken config validate          # Check kraken.jsonc syntax
```

---

## `kraken trigger`

```bash
kraken trigger list             # List configured triggers
kraken trigger test <name>      # Fire a trigger manually
```

---

## `kraken notification`

```bash
kraken notification list
kraken notification test <channel> --message "Hello from Kraken"
```

---

## `kraken mcp`

```bash
kraken mcp list
kraken mcp add myserver --command "npx -y @modelcontextprotocol/server-sqlite db.sqlite"
kraken mcp add remote --url https://mcp.example.com
kraken mcp remove myserver
kraken mcp enable myserver
kraken mcp disable myserver
```

---

## `kraken provider`

```bash
kraken provider list            # List providers and auth status
kraken provider configure openrouter
kraken provider remove openrouter
```

---

## `kraken stats`

```bash
kraken stats                    # Today
kraken stats --period week      # Last 7 days
kraken stats --period month     # Last 30 days
```

---

## `kraken logs`

```bash
kraken logs                     # Last 50 lines
kraken logs --lines 100
kraken logs --follow            # Stream in real-time
```

---

## `kraken clean`

```bash
kraken clean --tasks 30         # Remove tasks older than 30 days
kraken clean --worktrees        # Remove stale git worktrees
kraken clean --dry-run          # Preview without deleting
```

---

## `kraken doctor`

```bash
kraken doctor                   # Run diagnostic checks
kraken doctor --fix             # Auto-fix fixable issues
```

---

## `kraken uninstall`

```bash
kraken uninstall                # Remove everything
kraken uninstall --keep-global  # Keep ~/.kraken, remove project files
kraken uninstall --yes          # Skip confirmation
```

---

## Global flags

| Flag | Description |
| --- | --- |
| `--json` | JSON output for scripting |
| `--verbose` | Verbose logging to stderr |
