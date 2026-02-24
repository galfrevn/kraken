#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
DIM="\033[2m"
RESET="\033[0m"

step() { echo -e "\n${CYAN}${BOLD}=> $1${RESET}"; }
success() { echo -e "${GREEN}   $1${RESET}"; }
warn() { echo -e "${YELLOW}   $1${RESET}"; }
fail() { echo -e "${RED}${BOLD}   error: $1${RESET}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

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
echo -e "  ${DIM}autonomous developer agent — setup${RESET}\n"

# -------------------------------------------------------------------
# 1. Check dependencies
# -------------------------------------------------------------------
step "checking dependencies"

if ! command -v bun &>/dev/null; then
  fail "bun is not installed. Install it: https://bun.sh"
fi
BUN_VERSION=$(bun --version)
success "bun $BUN_VERSION"

if ! command -v cargo &>/dev/null; then
  fail "rust/cargo is not installed. Install it: https://rustup.rs"
fi
CARGO_VERSION=$(cargo --version | awk '{print $2}')
success "cargo $CARGO_VERSION"

if ! command -v go &>/dev/null; then
  fail "go is not installed. Install it: https://go.dev/dl"
fi
GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
success "go $GO_VERSION"

# -------------------------------------------------------------------
# 2. Install TypeScript dependencies
# -------------------------------------------------------------------
step "installing dependencies"
bun install
success "node modules installed"

# -------------------------------------------------------------------
# 3. Generate protobuf code
# -------------------------------------------------------------------
step "generating protobuf code"

if command -v buf &>/dev/null; then
  buf generate
  success "protobuf code generated"

  cd gen/go && go mod tidy && cd "$PROJECT_ROOT"
  cd apps/gateway && go mod tidy && cd "$PROJECT_ROOT"
  success "go modules synced"
else
  if [ -d gen/go/agent ] && [ -d gen/ts/agent ]; then
    warn "buf not installed, using existing generated code"
    warn "install buf for fresh generation: https://buf.build/docs/installation"
  else
    fail "buf is not installed and no generated code found. Install it: https://buf.build/docs/installation"
  fi
fi

# -------------------------------------------------------------------
# 4. Build scheduler (Rust)
# -------------------------------------------------------------------
step "building scheduler (rust)"
cd apps/scheduler
cargo build --release 2>&1 | tail -1
success "scheduler built → apps/scheduler/target/release/scheduler"
cd "$PROJECT_ROOT"

# -------------------------------------------------------------------
# 5. Build gateway (Go)
# -------------------------------------------------------------------
step "building gateway (go)"
cd apps/gateway
go build -o ./bin/gateway ./cmd/gateway
success "gateway built → apps/gateway/bin/gateway"
cd "$PROJECT_ROOT"

# -------------------------------------------------------------------
# 6. Setup environment
# -------------------------------------------------------------------
step "setting up environment"

if [ ! -f .env ]; then
  cp "$PROJECT_ROOT/apps/cli/templates/env.example" .env
  success "created .env from template"

  echo ""
  echo -e "   ${YELLOW}enter your OpenRouter API key (https://openrouter.ai/keys):${RESET}"
  read -r -p "   > " API_KEY

  if [ -n "$API_KEY" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$API_KEY|" .env
    else
      sed -i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$API_KEY|" .env
    fi
    success "API key saved to .env"
  else
    warn "no API key provided — edit .env manually before running kraken"
  fi
else
  success ".env already exists, skipping"
fi

if [ ! -f kraken.yml ]; then
  cp "$PROJECT_ROOT/apps/cli/templates/kraken.example.yml" kraken.yml

  if [ -n "${API_KEY:-}" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "/^languageModel:/a\\
\\  apiKey: $API_KEY" kraken.yml
    else
      sed -i "/^languageModel:/a\\  apiKey: $API_KEY" kraken.yml
    fi
  fi

  success "created kraken.yml from template"
else
  success "kraken.yml already exists, skipping"
fi

# -------------------------------------------------------------------
# 7. Register global CLI
# -------------------------------------------------------------------
step "registering kraken CLI"
bun link 2>&1 | tail -2
success "kraken command registered globally"

# -------------------------------------------------------------------
# 8. Verify
# -------------------------------------------------------------------
step "verifying installation"

if command -v kraken &>/dev/null; then
  success "kraken is available globally"
else
  LINKED_PATH="$HOME/.bun/bin/kraken"
  if [ -f "$LINKED_PATH" ]; then
    warn "kraken installed at $LINKED_PATH"
    warn "add ~/.bun/bin to your PATH if not already: export PATH=\"\$HOME/.bun/bin:\$PATH\""
  else
    warn "bun link completed but kraken may not be in PATH"
    warn "try: export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
fi

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  setup complete!${RESET}"
echo ""
echo -e "  ${BOLD}quick start:${RESET}"
echo -e "    ${CYAN}kraken${RESET}                    start kraken (scheduler + gateway + tui)"
echo -e "    ${CYAN}kraken init${RESET}               setup kraken in a project"
echo -e "    ${CYAN}kraken doctor${RESET}             check system health"
echo -e "    ${CYAN}kraken help${RESET}               see all commands"
echo ""
echo -e "  ${BOLD}use in another project:${RESET}"
echo -e "    ${CYAN}cd ~/your-project${RESET}"
echo -e "    ${CYAN}kraken init${RESET}"
echo ""
