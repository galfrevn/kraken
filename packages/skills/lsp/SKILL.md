---
name: lsp
description: Configure LSP language servers for real-time diagnostics after code edits
---

Kraken has built-in LSP integration that provides real-time diagnostics (errors, warnings) after every file edit. Language servers start lazily when you first edit a file of that language.

## Built-in Servers

| Name | Command | Extensions | Requires |
|------|---------|------------|----------|
| typescript | `typescript-language-server --stdio` | .ts .tsx .js .jsx | `npm i -g typescript-language-server typescript` |
| rust | `rust-analyzer` | .rs | `rustup component add rust-analyzer` |
| python | `pyright-langserver --stdio` | .py .pyi | `npm i -g pyright` |
| go | `gopls serve` | .go | `go install golang.org/x/tools/gopls@latest` |

Built-in servers are auto-detected. If the binary is not installed, the server is silently skipped.

## Adding a Custom Server

Edit `~/.kraken/kraken.jsonc` and add an entry under the `lsp` key:

```jsonc
{
  "lsp": {
    "elixir": {
      "command": ["elixir-ls"],
      "extensions": [".ex", ".exs"]
    },
    "zig": {
      "command": ["zls"],
      "extensions": [".zig"]
    },
    "svelte": {
      "command": ["svelteserver", "--stdio"],
      "extensions": [".svelte"]
    },
    "tailwindcss": {
      "command": ["tailwindcss-language-server", "--stdio"],
      "extensions": [".css", ".html"]
    }
  }
}
```

Requirements for custom servers:
- Must support `--stdio` transport (stdin/stdout JSON-RPC)
- Must support `textDocument/publishDiagnostics` notifications
- Binary must be in PATH

## Disabling Servers

Disable all LSP:
```jsonc
{ "lsp": false }
```

Disable a specific server:
```jsonc
{
  "lsp": {
    "typescript": { "enabled": false }
  }
}
```

## How It Works

1. You edit/write a file via tools
2. Kraken detects the file extension and starts the appropriate LSP server (if not running)
3. File content is sent to the server via `textDocument/didChange`
4. Server responds with `textDocument/publishDiagnostics`
5. Errors and warnings are appended to the tool result
6. You (the agent) see them immediately and can fix issues

## Common Server Install Commands

```bash
# TypeScript/JavaScript
npm i -g typescript-language-server typescript

# Python
npm i -g pyright

# Rust
rustup component add rust-analyzer

# Go
go install golang.org/x/tools/gopls@latest

# C/C++
# macOS: xcode-select --install (includes clangd)
# Linux: apt install clangd

# Elixir
# Follow https://github.com/elixir-lsp/elixir-ls

# Zig
# Download from https://github.com/zigtools/zls

# Svelte
npm i -g svelte-language-server

# Vue
npm i -g @vue/language-server

# Tailwind CSS
npm i -g @tailwindcss/language-server

# YAML
npm i -g yaml-language-server

# Bash
npm i -g bash-language-server

# Docker
npm i -g dockerfile-language-server-nodejs
```

## When to Use This Skill

- The user asks to set up diagnostics for a language not in the built-in list
- The user wants to configure or disable LSP servers
- You need to install a language server binary
