#!/bin/bash
#
# Start a Cloudflare quick tunnel to expose the Kraken daemon API.
# This creates a temporary public URL (no account needed).
#
# Usage:
#   ./scripts/widget/tunnel.sh
#
# The tunnel URL will be printed. Use it in the Scriptable widget.
# The URL changes each time you restart the tunnel.
#
# For a permanent URL, use: cloudflared tunnel create kraken
# See: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
#
# Prerequisites:
#   brew install cloudflare/cloudflare/cloudflared   (macOS)
#   sudo apt install cloudflared                     (Linux)

DAEMON_PORT="${KRAKEN_DAEMON_PORT:-50051}"

if ! command -v cloudflared &> /dev/null; then
  echo "cloudflared not found. Install it:"
  echo "  macOS:  brew install cloudflare/cloudflare/cloudflared"
  echo "  Linux:  sudo apt install cloudflared"
  exit 1
fi

echo "Starting tunnel to localhost:${DAEMON_PORT}..."
echo "The public URL will appear below. Use it in the Scriptable widget."
echo ""

cloudflared tunnel --url "http://localhost:${DAEMON_PORT}"
