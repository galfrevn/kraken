#!/usr/bin/env bash
# Copies the OpenTUI native library into the bundle and patches the dynamic import
# so the production bundle can load it without node_modules.

set -euo pipefail

DIST_APP="dist/app"
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')

case "$PLATFORM" in
  darwin) LIB_NAME="libopentui.dylib" ;;
  linux)  LIB_NAME="libopentui.so" ;;
  *)      echo "Unsupported platform: $PLATFORM"; exit 1 ;;
esac

# Find the native library in node_modules
NATIVE_LIB=$(find node_modules/.bun -name "$LIB_NAME" -type f 2>/dev/null | head -1)

if [ -z "$NATIVE_LIB" ]; then
  echo "Warning: $LIB_NAME not found in node_modules — skipping native lib patching"
  exit 0
fi

cp "$NATIVE_LIB" "$DIST_APP/$LIB_NAME"

# Patch the dynamic import to use the local file
sed -i.bak "s|var module = await import(\`@opentui/core-\${process.platform}-\${process.arch}/index.ts\`);|var module = { default: resolve2(import.meta.dirname, \"$LIB_NAME\") };|" "$DIST_APP/index.js"
rm -f "$DIST_APP/index.js.bak"

echo "✓ Patched native library: $LIB_NAME"
