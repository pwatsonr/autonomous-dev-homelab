#!/usr/bin/env bash
# Build the autonomous-dev-homelab plugin.
# SPEC: REQ-000055 TASK-002.
#
# Usage: bash scripts/build.sh
# Exit 0 on success.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

echo "[build] Running TypeScript compiler..."
cd "$PLUGIN_DIR"
npx tsc --project tsconfig.build.json

# Write a package.json in dist/ to override the parent package's "type":"module"
# so that the CommonJS output works correctly.
cat > dist/package.json <<'EOF'
{ "type": "commonjs" }
EOF

echo "[build] Setting executable bit on CLI entrypoints..."
# main.js is the shebang entry (imports from index.js); index.js is the library.
# We do NOT copy main.js → index.js as that would create a circular require.
chmod +x dist/cli/main.js 2>/dev/null || true
chmod +x dist/cli/index.js 2>/dev/null || true

echo "[build] Build complete. dist/cli/main.js and dist/cli/index.js are ready."
