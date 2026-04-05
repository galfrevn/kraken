# Installation

## Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash
```

The installer detects your platform, downloads pre-built binaries from the latest GitHub release, and runs the setup wizard. Bun is installed automatically if missing.

To install a specific version:

```bash
KRAKEN_VERSION=v0.1.4 curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash
```

### What gets installed

```
~/.kraken/
  bin/kraken              CLI shim (added to PATH)
  lib/kraken              Daemon binary (Rust)
  lib/app/index.js        Terminal UI (bundled)
  lib/worker.js           Background task worker (bundled)
  lib/channel-worker.js   Messaging channel worker (bundled)
  skills/                 Built-in skill definitions
```

---

## From source

For development or contributing:

```bash
git clone https://github.com/galfrevn/kraken.git
cd kraken
bun install
bun run dev
```

Requires [Bun](https://bun.sh) 1.3.10+ and [Rust](https://rustup.rs) stable (edition 2024).

---

## First run

After installation, the setup wizard runs automatically. It asks for:

1. **LLM provider** — OpenRouter, Anthropic, or OpenAI
2. **API key** — Saved to `~/.kraken/.env`
3. **Triggers** — Optional cron jobs and file watchers
4. **Notifications** — Optional Slack or Discord webhooks

To re-run the wizard:

```bash
kraken init
```

---

## Verify

```bash
kraken doctor           # Check system health
kraken --help           # Print available commands
kraken daemon status    # Check daemon status
```

The `doctor` command validates Bun, Git, ripgrep, config files, API keys, database integrity, and disk space.

---

## Uninstall

```bash
kraken uninstall              # Remove everything
kraken uninstall --keep-global  # Remove project files only, keep ~/.kraken
```
