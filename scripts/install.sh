#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

KRAKEN_HOME="$HOME/.kraken"
KRAKEN_BIN="$KRAKEN_HOME/bin"
KRAKEN_LIB="$KRAKEN_HOME/lib"
GITHUB_REPO="galfrevn/kraken"
GITHUB_API="https://api.github.com/repos/$GITHUB_REPO"

step()    { echo -e "\n${CYAN}${BOLD}=> $1${RESET}"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $1"; }
fail()    { echo -e "  ${RED}✗ $1${RESET}"; exit 1; }

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      fail "unsupported operating system: $(uname -s). Kraken supports macOS and Linux." ;;
  esac

  case "$(uname -m)" in
    x86_64)  arch="x64" ;;
    aarch64) arch="arm64" ;;
    arm64)   arch="arm64" ;;
    *)       fail "unsupported architecture: $(uname -m)" ;;
  esac

  echo "$os-$arch"
}

echo -e "${CYAN}"
echo " ██ ▄█▀ ██▀███   ▄▄▄       ██ ▄█▀▓█████  ███▄    █ "
echo " ██▄█▒ ▓██ ▒ ██▒▒████▄     ██▄█▒ ▓█   ▀  ██ ▀█   █ "
echo "▓███▄░ ▓██ ░▄█ ▒▒██  ▀█▄  ▓███▄░ ▒███   ▓██  ▀█ ██▒"
echo "▓██ █▄ ▒██▀▀█▄  ░██▄▄▄▄██ ▓██ █▄ ▒▓█  ▄ ▓██▒  ▐▌██▒"
echo "▒██▒ █▄░██▓ ▒██▒ ▓█   ▓██▒▒██▒ █▄░▒████▒▒██░   ▓██░"
echo "▒ ▒▒ ▓▒░ ▒▓ ░▒▓░ ▒▒   ▓▒█░▒ ▒▒ ▓▒░░ ▒░ ░░ ▒░   ▒ ▒ "
echo "░ ░▒ ▒░  ░▒ ░ ▒░  ▒   ▒▒ ░░ ░▒ ▒░ ░ ░  ░░ ░░   ░ ▒░"
echo "░ ░░ ░   ░░   ░   ░   ▒   ░ ░░ ░    ░      ░   ░ ░ "
echo "░  ░      ░           ░  ░░  ░      ░  ░         ░ "
echo -e "${RESET}"
echo -e "  ${DIM}autonomous developer agent — installer${RESET}\n"

PLATFORM=$(detect_platform)
success "detected platform: $PLATFORM"

# ── Check bun (required as runtime for app/workers) ──────────────────────

step "checking bun"

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version)
  success "bun v$BUN_VERSION"
else
  warn "bun is not installed (required runtime)"

  prompt() {
    local question="$1"
    local default_value="${2:-}"
    local suffix=""
    if [ -n "$default_value" ]; then
      suffix=" ${DIM}[$default_value]${RESET}"
    fi
    echo -en "  $question$suffix: " >&2
    read -r answer
    echo "${answer:-$default_value}"
  }

  INSTALL_BUN=$(prompt "Install bun automatically? (Y/n)" "y")

  if [[ "$INSTALL_BUN" =~ ^[Yy]$ ]] || [ -z "$INSTALL_BUN" ]; then
    echo ""
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if command -v bun &>/dev/null; then
      success "bun installed: v$(bun --version)"
    else
      fail "bun installation failed. Install manually: https://bun.sh"
    fi
  else
    fail "bun is required. Install it: https://bun.sh"
  fi
fi

# ── Download pre-built release ───────────────────────────────────────────

step "fetching latest release"

# Allow overriding the version via KRAKEN_VERSION env var
if [ -n "${KRAKEN_VERSION:-}" ]; then
  RELEASE_TAG="$KRAKEN_VERSION"
  success "using specified version: $RELEASE_TAG"
else
  RELEASE_TAG=$(curl -fsSL "$GITHUB_API/releases/latest" 2>/dev/null \
    | grep -o '"tag_name": "[^"]*"' \
    | head -1 \
    | cut -d'"' -f4) || true

  if [ -z "${RELEASE_TAG:-}" ]; then
    fail "could not fetch latest release from GitHub.\n    Check your internet connection or set KRAKEN_VERSION=v0.x.x manually."
  fi
  success "latest release: $RELEASE_TAG"
fi

DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$RELEASE_TAG/kraken-$PLATFORM.tar.gz"
TMPDIR_INSTALL=$(mktemp -d)
ARCHIVE_PATH="$TMPDIR_INSTALL/kraken.tar.gz"

step "downloading kraken-$PLATFORM ($RELEASE_TAG)"

HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$ARCHIVE_PATH" "$DOWNLOAD_URL" 2>/dev/null) || true

if [ ! -f "$ARCHIVE_PATH" ] || [ "${HTTP_CODE:-0}" != "200" ]; then
  rm -rf "$TMPDIR_INSTALL"
  fail "download failed (HTTP $HTTP_CODE).\n    URL: $DOWNLOAD_URL\n    Make sure release $RELEASE_TAG has artifacts for $PLATFORM."
fi

ARCHIVE_SIZE=$(wc -c < "$ARCHIVE_PATH" | tr -d ' ')
ARCHIVE_SIZE_MB=$(echo "scale=1; $ARCHIVE_SIZE / 1048576" | bc 2>/dev/null || echo "?")
success "downloaded ${ARCHIVE_SIZE_MB} MB"

# ── Install ──────────────────────────────────────────────────────────────

step "installing to ~/.kraken"

mkdir -p "$KRAKEN_BIN"
mkdir -p "$KRAKEN_LIB"
mkdir -p "$KRAKEN_HOME/config"
mkdir -p "$KRAKEN_HOME/data"

EXTRACT_DIR="$TMPDIR_INSTALL/extracted"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

# Daemon binary
if [ -f "$EXTRACT_DIR/kraken" ]; then
  cp "$EXTRACT_DIR/kraken" "$KRAKEN_LIB/kraken"
  chmod +x "$KRAKEN_LIB/kraken"
  success "daemon binary installed"
else
  rm -rf "$TMPDIR_INSTALL"
  fail "daemon binary not found in release archive"
fi

# Bundled app (TUI)
if [ -d "$EXTRACT_DIR/app" ]; then
  rm -rf "$KRAKEN_LIB/app"
  cp -r "$EXTRACT_DIR/app" "$KRAKEN_LIB/app"
  success "TUI app installed"
else
  warn "TUI app bundle not found in release (development install may be needed)"
fi

# Bundled workers
if [ -f "$EXTRACT_DIR/worker.js" ]; then
  cp "$EXTRACT_DIR/worker.js" "$KRAKEN_LIB/worker.js"
  success "worker installed"
fi

if [ -f "$EXTRACT_DIR/channel-worker.js" ]; then
  cp "$EXTRACT_DIR/channel-worker.js" "$KRAKEN_LIB/channel-worker.js"
  success "channel worker installed"
fi

# Skills
if [ -d "$EXTRACT_DIR/skills" ]; then
  rm -rf "$KRAKEN_HOME/skills"
  cp -r "$EXTRACT_DIR/skills" "$KRAKEN_HOME/skills"
  SKILL_COUNT=$(find "$KRAKEN_HOME/skills" -name "SKILL.md" | wc -l | tr -d ' ')
  success "$SKILL_COUNT skills installed"
fi

# Cleanup temp files
rm -rf "$TMPDIR_INSTALL"

# ── CLI shim ─────────────────────────────────────────────────────────────

step "creating CLI"

cat > "$KRAKEN_BIN/kraken" << 'SHIM'
#!/usr/bin/env bash
KRAKEN_LIB="$HOME/.kraken/lib"
KRAKEN_BIN="$KRAKEN_LIB/kraken"

if [ -x "$KRAKEN_BIN" ]; then
  exec "$KRAKEN_BIN" "$@"
else
  echo "error: kraken binary not found at $KRAKEN_BIN" >&2
  echo "try reinstalling: curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash" >&2
  exit 1
fi
SHIM

chmod +x "$KRAKEN_BIN/kraken"
success "created $KRAKEN_BIN/kraken"

echo "$RELEASE_TAG" > "$KRAKEN_HOME/version"

# ── PATH ─────────────────────────────────────────────────────────────────

step "configuring PATH"

add_to_path() {
  local rc_file="$1"
  local line='export PATH="$HOME/.kraken/bin:$PATH"'

  if [ -f "$rc_file" ] && grep -q ".kraken/bin" "$rc_file" 2>/dev/null; then
    return 0
  fi

  echo "" >> "$rc_file"
  echo "# kraken" >> "$rc_file"
  echo "$line" >> "$rc_file"
  return 1
}

PATH_ADDED=false

CURRENT_SHELL=$(basename "${SHELL:-/bin/bash}")
case "$CURRENT_SHELL" in
  zsh)
    add_to_path "$HOME/.zshrc" && true || PATH_ADDED=true
    ;;
  bash)
    if [ -f "$HOME/.bash_profile" ]; then
      add_to_path "$HOME/.bash_profile" && true || PATH_ADDED=true
    else
      add_to_path "$HOME/.bashrc" && true || PATH_ADDED=true
    fi
    ;;
  fish)
    FISH_CONFIG="$HOME/.config/fish/config.fish"
    if [ -f "$FISH_CONFIG" ] && ! grep -q ".kraken/bin" "$FISH_CONFIG" 2>/dev/null; then
      echo "" >> "$FISH_CONFIG"
      echo "# kraken" >> "$FISH_CONFIG"
      echo 'set -gx PATH $HOME/.kraken/bin $PATH' >> "$FISH_CONFIG"
      PATH_ADDED=true
    fi
    ;;
esac

if [ "$PATH_ADDED" = true ]; then
  success "added ~/.kraken/bin to PATH in ${CURRENT_SHELL}rc"
else
  if echo "$PATH" | grep -q ".kraken/bin"; then
    success "~/.kraken/bin already in PATH"
  else
    warn "could not detect shell config — add manually:"
    echo -e "    ${CYAN}export PATH=\"\$HOME/.kraken/bin:\$PATH\"${RESET}"
  fi
fi

export PATH="$KRAKEN_BIN:$PATH"

# ── Verify ───────────────────────────────────────────────────────────────

step "verifying installation"

if [ -x "$KRAKEN_LIB/kraken" ]; then
  success "daemon binary at $KRAKEN_LIB/kraken"
fi

if [ -f "$KRAKEN_LIB/app/index.js" ]; then
  success "TUI app at $KRAKEN_LIB/app/index.js"
fi

if [ -x "$KRAKEN_BIN/kraken" ]; then
  success "CLI shim at $KRAKEN_BIN/kraken"
fi

echo ""
echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
echo ""

# ── Init wizard ──────────────────────────────────────────────────────────

step "initial setup"
echo ""
echo -e "  Kraken needs some initial configuration (LLM provider, API key, etc.)"
echo -e "  Running ${CYAN}kraken init${RESET} to get you started...\n"

"$KRAKEN_BIN/kraken" init

echo ""
echo -e "${GREEN}${BOLD}  You're all set!${RESET}"
echo ""
echo -e "  ${CYAN}Usage:${RESET}"
echo -e "    kraken start            Start TUI + daemon"
echo -e "    kraken daemon start     Start daemon in background"
echo -e "    kraken daemon status    Check daemon status"
echo -e "    kraken daemon stop      Stop daemon"
echo -e "    kraken doctor           Check system health"
echo ""
echo -e "  ${DIM}Restart your shell or run: export PATH=\"\$HOME/.kraken/bin:\$PATH\"${RESET}"
echo ""
