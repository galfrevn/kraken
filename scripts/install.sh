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

prompt_select() {
  local question="$1"
  shift
  local options=("$@")

  echo -e "\n  ${BOLD}$question${RESET}\n" >&2
  for i in "${!options[@]}"; do
    echo -e "    ${CYAN}$((i + 1)))${RESET} ${options[$i]}" >&2
  done
  echo "" >&2

  local answer
  answer=$(prompt "Choose an option" "1")
  local index=$((answer - 1))

  if [ "$index" -ge 0 ] && [ "$index" -lt "${#options[@]}" ]; then
    echo "$index"
  else
    echo "0"
  fi
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
# 1. Check / install Bun
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
mkdir -p "$KRAKEN_HOME/lib"
mkdir -p "$KRAKEN_HOME/config"

if [ -d "$KRAKEN_HOME/lib/tui" ]; then
  warn "existing installation found, updating..."
  UPDATING=true
else
  UPDATING=false
fi

# -------------------------------------------------------------------
# 3. Try downloading pre-built release
# -------------------------------------------------------------------
step "downloading kraken"

PREBUILT_OK=false

if command -v curl &>/dev/null; then
  LATEST_RELEASE=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || echo "")

  if [ -n "$LATEST_RELEASE" ]; then
    RELEASE_TAG=$(echo "$LATEST_RELEASE" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

    if [ -n "$RELEASE_TAG" ]; then
      ASSET_NAME="kraken-$PLATFORM.tar.gz"
      DOWNLOAD_URL="$GITHUB_URL/releases/download/$RELEASE_TAG/$ASSET_NAME"

      echo -e "  ${DIM}trying $DOWNLOAD_URL${RESET}"

      if curl -fsSL -o "/tmp/$ASSET_NAME" "$DOWNLOAD_URL" 2>/dev/null; then
        tar -xzf "/tmp/$ASSET_NAME" -C "$KRAKEN_HOME/lib/" 2>/dev/null && PREBUILT_OK=true
        rm -f "/tmp/$ASSET_NAME"

        if [ "$PREBUILT_OK" = true ]; then
          success "downloaded pre-built binaries ($RELEASE_TAG)"
        fi
      fi
    fi
  fi
fi

# -------------------------------------------------------------------
# 4. Fallback: build from source
# -------------------------------------------------------------------
if [ "$PREBUILT_OK" = false ]; then
  warn "no pre-built release available, building from source"

  HAS_CARGO=false
  HAS_GO=false

  if command -v cargo &>/dev/null; then
    HAS_CARGO=true
    success "cargo found: $(cargo --version | awk '{print $2}')"
  else
    warn "cargo not found -- scheduler won't be pre-built (https://rustup.rs)"
  fi

  if command -v go &>/dev/null; then
    HAS_GO=true
    success "go found: $(go version | awk '{print $3}' | sed 's/go//')"
  else
    warn "go not found -- gateway won't be pre-built (https://go.dev/dl)"
  fi

  step "cloning repository"

  if [ -d "$KRAKEN_HOME/lib/tui/.git" ]; then
    cd "$KRAKEN_HOME/lib/tui"
    git pull --rebase --quiet
    success "updated source code"
  else
    rm -rf "$KRAKEN_HOME/lib/tui"
    git clone --depth 1 "$GITHUB_URL.git" "$KRAKEN_HOME/lib/tui"
    success "cloned repository"
  fi

  cd "$KRAKEN_HOME/lib/tui"

  step "installing dependencies"
  bun install --frozen-lockfile 2>/dev/null || bun install
  success "dependencies installed"

  if [ "$HAS_CARGO" = true ]; then
    step "building scheduler (rust)"
    cd apps/scheduler
    cargo build --release 2>&1 | tail -1
    cp target/release/scheduler "$KRAKEN_HOME/lib/scheduler" 2>/dev/null || true
    success "scheduler built"
    cd "$KRAKEN_HOME/lib/tui"
  fi

  if [ "$HAS_GO" = true ]; then
    step "building gateway (go)"
    cd apps/gateway
    go build -o ./bin/gateway ./cmd/gateway
    cp bin/gateway "$KRAKEN_HOME/lib/gateway" 2>/dev/null || true
    success "gateway built"
    cd "$KRAKEN_HOME/lib/tui"
  fi
fi

# -------------------------------------------------------------------
# 5. Create CLI shim
# -------------------------------------------------------------------
step "creating CLI"

cat > "$KRAKEN_BIN/kraken" << 'SHIM'
#!/usr/bin/env bash
exec bun run "$HOME/.kraken/lib/tui/apps/cli/src/index.ts" "$@"
SHIM

chmod +x "$KRAKEN_BIN/kraken"
success "created $KRAKEN_BIN/kraken"

# -------------------------------------------------------------------
# 6. Copy config templates
# -------------------------------------------------------------------
step "setting up configuration"

if [ -d "$KRAKEN_HOME/lib/tui/apps/cli/templates" ]; then
  cp -n "$KRAKEN_HOME/lib/tui/apps/cli/templates/env.example" "$KRAKEN_HOME/config/.env.example" 2>/dev/null || true
  cp -n "$KRAKEN_HOME/lib/tui/apps/cli/templates/kraken.example.yml" "$KRAKEN_HOME/config/kraken.example.yml" 2>/dev/null || true
  success "config templates copied"
fi

# -------------------------------------------------------------------
# 7. Interactive wizard (skip if updating)
# -------------------------------------------------------------------
if [ "$UPDATING" = false ]; then
  step "configuration wizard"

  PROVIDER_OPTIONS=("OpenRouter (recommended)" "Anthropic (Claude)" "OpenAI (GPT)")
  PROVIDER_IDS=("openrouter" "anthropic" "openai")
  PROVIDER_IDX=$(prompt_select "Select LLM provider" "${PROVIDER_OPTIONS[@]}")
  PROVIDER="${PROVIDER_IDS[$PROVIDER_IDX]}"
  success "provider: $PROVIDER"

  if [ "$PROVIDER" = "openrouter" ]; then
    MODEL_OPTIONS=("Claude Sonnet 4 (recommended)" "DeepSeek V3.2 (fast, cheap)" "Gemini 2.5 Pro")
    MODEL_IDS=("anthropic/claude-sonnet-4" "deepseek/deepseek-v3.2" "google/gemini-2.5-pro")
  elif [ "$PROVIDER" = "anthropic" ]; then
    MODEL_OPTIONS=("Claude Sonnet 4" "Claude Sonnet 4.6")
    MODEL_IDS=("claude-sonnet-4" "claude-sonnet-4.6")
  else
    MODEL_OPTIONS=("GPT-4o" "o3-mini")
    MODEL_IDS=("gpt-4o" "o3-mini")
  fi

  MODEL_IDX=$(prompt_select "Select model" "${MODEL_OPTIONS[@]}")
  MODEL="${MODEL_IDS[$MODEL_IDX]}"
  success "model: $MODEL"

  echo ""
  API_KEY=$(prompt "Enter your $PROVIDER API key")

  if [ -n "$API_KEY" ]; then
    echo "OPENROUTER_API_KEY=$API_KEY" > "$KRAKEN_HOME/config/.env"
    success "API key saved"
  else
    warn "no API key provided -- set it later in ~/.kraken/config/.env"
    touch "$KRAKEN_HOME/config/.env"
  fi

  # Write version marker
  if [ -n "${RELEASE_TAG:-}" ]; then
    echo "$RELEASE_TAG" > "$KRAKEN_HOME/version"
  else
    echo "source" > "$KRAKEN_HOME/version"
  fi
else
  success "keeping existing configuration"
fi

# -------------------------------------------------------------------
# 8. Add to PATH
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
# 9. Verify
# -------------------------------------------------------------------
step "verifying installation"

if command -v kraken &>/dev/null || [ -x "$KRAKEN_BIN/kraken" ]; then
  "$KRAKEN_BIN/kraken" version 2>/dev/null && success "kraken is working" || success "kraken installed at $KRAKEN_BIN/kraken"
else
  warn "kraken installed but may not be in PATH yet"
fi

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
echo ""
echo -e "  ${BOLD}Get started:${RESET}"
echo ""
echo -e "    ${CYAN}kraken init${RESET}      setup kraken in your project"
echo -e "    ${CYAN}kraken${RESET}           start the agent"
echo -e "    ${CYAN}kraken doctor${RESET}    check system health"
echo -e "    ${CYAN}kraken help${RESET}      see all commands"
echo ""
if [ "$PATH_ADDED" = true ]; then
  echo -e "  ${YELLOW}Restart your terminal${RESET} or run: ${CYAN}source ~/.${CURRENT_SHELL}rc${RESET}"
  echo ""
fi
