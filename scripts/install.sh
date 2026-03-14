#!/usr/bin/env bash
#
# Kraken Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash
#
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
KRAKEN_SRC="$KRAKEN_LIB/tui"
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
    *)      fail "unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64)  arch="x64" ;;
    aarch64) arch="arm64" ;;
    arm64)   arch="arm64" ;;
    *)       fail "unsupported architecture: $(uname -m)" ;;
  esac

  echo "$os-$arch"
}

# ===================================================================

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

# -------------------------------------------------------------------
# 1. Check / install Bun (the only hard requirement)
# -------------------------------------------------------------------
step "checking bun"

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version)
  success "bun v$BUN_VERSION"
else
  warn "bun is not installed"
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

# -------------------------------------------------------------------
# 2. Prepare install directory
# -------------------------------------------------------------------
step "preparing installation"

mkdir -p "$KRAKEN_BIN"
mkdir -p "$KRAKEN_LIB"
mkdir -p "$KRAKEN_HOME/config"

if [ -d "$KRAKEN_SRC" ]; then
  warn "existing installation found, updating..."
fi

# -------------------------------------------------------------------
# 3. Clone / update the repository (always needed for TypeScript code)
# -------------------------------------------------------------------
step "fetching kraken source"

if ! command -v git &>/dev/null; then
  fail "git is required. Install it: https://git-scm.com"
fi

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

# -------------------------------------------------------------------
# 4. Install TypeScript dependencies
# -------------------------------------------------------------------
step "installing dependencies"
bun install --frozen-lockfile 2>/dev/null || bun install
success "dependencies installed"

# -------------------------------------------------------------------
# 5. Get scheduler & gateway binaries (pre-built or build from source)
# -------------------------------------------------------------------
step "setting up native binaries"

PREBUILT_OK=false
RELEASE_TAG=""

# Try downloading pre-built binaries from the latest release
if command -v curl &>/dev/null; then
  LATEST_RELEASE=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || echo "")

  if [ -n "$LATEST_RELEASE" ]; then
    RELEASE_TAG=$(echo "$LATEST_RELEASE" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

    if [ -n "$RELEASE_TAG" ]; then
      ASSET_NAME="kraken-$PLATFORM.tar.gz"
      DOWNLOAD_URL="$GITHUB_URL/releases/download/$RELEASE_TAG/$ASSET_NAME"

      echo -e "  ${DIM}trying $DOWNLOAD_URL${RESET}"

      if curl -fsSL -o "/tmp/$ASSET_NAME" "$DOWNLOAD_URL" 2>/dev/null; then
        tar -xzf "/tmp/$ASSET_NAME" -C "$KRAKEN_LIB/" 2>/dev/null && PREBUILT_OK=true
        rm -f "/tmp/$ASSET_NAME"

        if [ "$PREBUILT_OK" = true ]; then
          success "downloaded pre-built binaries ($RELEASE_TAG)"
        fi
      fi
    fi
  fi
fi

# Fallback: build from source if pre-built binaries are not available
if [ "$PREBUILT_OK" = false ]; then
  warn "no pre-built binaries available, trying to build from source"

  if command -v cargo &>/dev/null; then
    success "cargo found: $(cargo --version | awk '{print $2}')"
    step "building scheduler (rust)"
    cd apps/scheduler
    cargo build --release 2>&1 | tail -1
    cp target/release/scheduler "$KRAKEN_LIB/scheduler" 2>/dev/null || true
    success "scheduler built"
    cd "$KRAKEN_SRC"
  else
    warn "cargo not found -- scheduler won't be available (https://rustup.rs)"
  fi

  if command -v go &>/dev/null; then
    success "go found: $(go version | awk '{print $3}' | sed 's/go//')"
    step "building gateway (go)"
    cd apps/gateway
    go build -o ./bin/gateway ./cmd/gateway
    cp bin/gateway "$KRAKEN_LIB/gateway" 2>/dev/null || true
    success "gateway built"
    cd "$KRAKEN_SRC"
  else
    warn "go not found -- gateway won't be available (https://go.dev/dl)"
  fi
fi

# -------------------------------------------------------------------
# 6. Create CLI shim
# -------------------------------------------------------------------
step "creating CLI"

cat > "$KRAKEN_BIN/kraken" << 'SHIM'
#!/usr/bin/env bash
exec bun run "$HOME/.kraken/lib/tui/apps/cli/src/index.ts" "$@"
SHIM

chmod +x "$KRAKEN_BIN/kraken"
success "created $KRAKEN_BIN/kraken"

# -------------------------------------------------------------------
# 7. Copy config templates
# -------------------------------------------------------------------
step "setting up configuration"

if [ -d "$KRAKEN_SRC/apps/cli/templates" ]; then
  cp -n "$KRAKEN_SRC/apps/cli/templates/env.example" "$KRAKEN_HOME/config/.env.example" 2>/dev/null || true
  cp -n "$KRAKEN_SRC/apps/cli/templates/kraken.example.yml" "$KRAKEN_HOME/config/kraken.example.yml" 2>/dev/null || true
  success "config templates copied"
fi

# -------------------------------------------------------------------
# 8. Write version marker
# -------------------------------------------------------------------
if [ -n "${RELEASE_TAG:-}" ]; then
  echo "$RELEASE_TAG" > "$KRAKEN_HOME/version"
else
  echo "source" > "$KRAKEN_HOME/version"
fi

# -------------------------------------------------------------------
# 9. Add to PATH
# -------------------------------------------------------------------
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
    warn "could not detect shell config -- add manually:"
    echo -e "    ${CYAN}export PATH=\"\$HOME/.kraken/bin:\$PATH\"${RESET}"
  fi
fi

export PATH="$KRAKEN_BIN:$PATH"

# -------------------------------------------------------------------
# 10. Verify
# -------------------------------------------------------------------
step "verifying installation"

if command -v kraken &>/dev/null || [ -x "$KRAKEN_BIN/kraken" ]; then
  "$KRAKEN_BIN/kraken" version 2>/dev/null && success "kraken is working" || success "kraken installed at $KRAKEN_BIN/kraken"
else
  warn "kraken installed but may not be in PATH yet"
fi

# -------------------------------------------------------------------
# Done — run init
# -------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
echo ""

step "running kraken init"
"$KRAKEN_BIN/kraken" init
