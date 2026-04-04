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
KRAKEN_SRC="$KRAKEN_LIB/src"
GITHUB_REPO="galfrevn/kraken"
GITHUB_URL="https://github.com/$GITHUB_REPO"

step()    { echo -e "\n${CYAN}${BOLD}=> $1${RESET}"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $1"; }
fail()    { echo -e "  ${RED}✗ $1${RESET}"; exit 1; }

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

step "checking bun"

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version)
  success "bun v$BUN_VERSION"
else
  warn "bun is not installed (required for TUI)"
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
    fail "bun is required for the TUI. Install it: https://bun.sh"
  fi
fi

step "checking rust"

if command -v cargo &>/dev/null; then
  CARGO_VERSION=$(cargo --version | awk '{print $2}')
  success "cargo $CARGO_VERSION"
else
  warn "rust/cargo is not installed (required for daemon)"
  INSTALL_RUST=$(prompt "Install rust via rustup automatically? (Y/n)" "y")

  if [[ "$INSTALL_RUST" =~ ^[Yy]$ ]] || [ -z "$INSTALL_RUST" ]; then
    echo ""
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"

    if command -v cargo &>/dev/null; then
      success "rust installed: $(cargo --version | awk '{print $2}')"
    else
      fail "rust installation failed. Install manually: https://rustup.rs"
    fi
  else
    fail "rust is required for the daemon. Install it: https://rustup.rs"
  fi
fi

step "checking git"

if ! command -v git &>/dev/null; then
  fail "git is required. Install it: https://git-scm.com"
fi
success "git $(git --version | awk '{print $3}')"

step "preparing installation"

mkdir -p "$KRAKEN_BIN"
mkdir -p "$KRAKEN_LIB"
mkdir -p "$KRAKEN_HOME/config"

if [ -d "$KRAKEN_SRC" ]; then
  warn "existing installation found, updating..."
fi

step "fetching kraken source"

if [ -d "$KRAKEN_SRC/.git" ]; then
  cd "$KRAKEN_SRC"
  git pull --rebase --quiet
  success "updated source code"
else
  rm -rf "$KRAKEN_SRC"
  git clone --depth 1 "$GITHUB_URL.git" "$KRAKEN_SRC"
  success "cloned repository"
fi

cd "$KRAKEN_SRC"

step "installing dependencies"
bun install --frozen-lockfile 2>/dev/null || bun install
success "node modules installed"

step "building daemon + CLI (rust)"

cd apps/daemon
cargo build --release 2>&1 | tail -5
DAEMON_BIN="$KRAKEN_SRC/apps/daemon/target/release/kraken"

if [ ! -f "$DAEMON_BIN" ]; then
  fail "daemon build failed — binary not found at $DAEMON_BIN"
fi

cp "$DAEMON_BIN" "$KRAKEN_LIB/kraken"
chmod +x "$KRAKEN_LIB/kraken"
success "daemon built"
cd "$KRAKEN_SRC"

step "building TUI app"

cd apps/app
bun build src/index.tsx --outdir "$KRAKEN_LIB/app" --target bun 2>&1 | tail -3
success "TUI app built"
cd "$KRAKEN_SRC"

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

RELEASE_TAG=$(cd "$KRAKEN_SRC" && git describe --tags --abbrev=0 2>/dev/null || echo "source")
echo "$RELEASE_TAG" > "$KRAKEN_HOME/version"

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

step "verifying installation"

if [ -x "$KRAKEN_LIB/kraken" ]; then
  success "daemon + CLI installed at $KRAKEN_LIB/kraken"
fi

if [ -x "$KRAKEN_BIN/kraken" ]; then
  success "CLI shim installed at $KRAKEN_BIN/kraken"
fi

echo ""
echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
echo ""

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
echo ""
echo -e "  ${DIM}Restart your shell or run: export PATH=\"\$HOME/.kraken/bin:\$PATH\"${RESET}"
echo ""
