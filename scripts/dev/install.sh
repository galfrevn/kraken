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

step()    { echo -e "\n${CYAN}${BOLD}=> $1${RESET}"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $1"; }
fail()    { echo -e "  ${RED}✗ $1${RESET}"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

step "checking prerequisites"

command -v cargo &>/dev/null || fail "rust/cargo not found. Install: https://rustup.rs"
success "cargo $(cargo --version | awk '{print $2}')"

command -v bun &>/dev/null || fail "bun not found. Install: https://bun.sh"
success "bun v$(bun --version)"

step "installing dependencies"

cd "$REPO_ROOT"
bun install --frozen-lockfile 2>/dev/null || bun install
success "node modules installed"

step "building daemon (debug)"

cd "$REPO_ROOT/apps/daemon"
cargo build 2>&1 | tail -5

DAEMON_BIN="$REPO_ROOT/apps/daemon/target/debug/kraken"
[ -f "$DAEMON_BIN" ] || fail "build failed — binary not found at $DAEMON_BIN"
success "daemon built at $DAEMON_BIN"

step "creating dev shim"

mkdir -p "$KRAKEN_BIN"

cat > "$KRAKEN_BIN/kraken" << 'SHIM'
#!/usr/bin/env bash
REPO_ROOT="REPO_ROOT_PLACEHOLDER"
DAEMON_BIN="$REPO_ROOT/apps/daemon/target/debug/kraken"

needs_rebuild() {
  [ ! -f "$DAEMON_BIN" ] && return 0
  local bin_mtime
  bin_mtime=$(stat -f %m "$DAEMON_BIN" 2>/dev/null || stat -c %Y "$DAEMON_BIN" 2>/dev/null)
  while IFS= read -r -d '' src_file; do
    local src_mtime
    src_mtime=$(stat -f %m "$src_file" 2>/dev/null || stat -c %Y "$src_file" 2>/dev/null)
    [ "$src_mtime" -gt "$bin_mtime" ] && return 0
  done < <(find "$REPO_ROOT/apps/daemon/src" -name '*.rs' -print0)
  return 1
}

if needs_rebuild; then
  printf '\033[2m[kraken-dev] rebuilding daemon...\033[0m\n' >&2
  cargo build --manifest-path "$REPO_ROOT/apps/daemon/Cargo.toml" --quiet 2>&1 >&2 || {
    printf '\033[0;31m[kraken-dev] build failed\033[0m\n' >&2
    exit 1
  }
  printf '\033[2m[kraken-dev] done\033[0m\n' >&2
fi

cd "$REPO_ROOT" || exit 1
exec "$DAEMON_BIN" "$@"
SHIM

if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s|REPO_ROOT_PLACEHOLDER|$REPO_ROOT|g" "$KRAKEN_BIN/kraken"
else
  sed -i "s|REPO_ROOT_PLACEHOLDER|$REPO_ROOT|g" "$KRAKEN_BIN/kraken"
fi

chmod +x "$KRAKEN_BIN/kraken"
success "shim installed at $KRAKEN_BIN/kraken"

if ! echo "$PATH" | grep -q ".kraken/bin"; then
  warn "add ~/.kraken/bin to your PATH if not already done:"
  echo -e "    ${CYAN}export PATH=\"\$HOME/.kraken/bin:\$PATH\"${RESET}"
fi

step "initial setup"

export PATH="$KRAKEN_BIN:$PATH"
"$KRAKEN_BIN/kraken" init

echo ""
echo -e "${GREEN}${BOLD}  Dev install complete!${RESET}"
echo ""
echo -e "  ${CYAN}Usage:${RESET}"
echo -e "    kraken start --dev      Start TUI (hot reload) + daemon"
echo -e "    kraken start --no-daemon  Start TUI only (daemon already running)"
echo -e "    kraken daemon run       Run daemon in foreground"
echo -e "    kraken task list        Use any CLI command"
echo ""
echo -e "  ${DIM}The daemon auto-rebuilds when source files change.${RESET}"
echo ""
