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

if command -v go &>/dev/null; then
  GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
  success "go $GO_VERSION (optional)"
fi

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
# 4. Build daemon (Rust)
# -------------------------------------------------------------------
step "building daemon (rust)"
cd apps/daemon
cargo build --release 2>&1 | tail -1
success "daemon built → apps/daemon/target/release/kraken-daemon"
cd "$PROJECT_ROOT"

# -------------------------------------------------------------------
# 5. Register global CLI
# -------------------------------------------------------------------
step "registering kraken CLI"
bun link 2>&1 | tail -2
success "kraken command registered globally"

# -------------------------------------------------------------------
# 6. Verify
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
# Done — run init
# -------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  build complete!${RESET}"
echo ""

step "running kraken init"
kraken init
