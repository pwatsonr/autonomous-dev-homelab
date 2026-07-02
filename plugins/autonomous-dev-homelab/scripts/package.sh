#!/usr/bin/env bash
# Package the plugin as a tarball.
# SPEC: REQ-000055 TASK-003.
#
# Usage: bash scripts/package.sh
# Produces: dist/autonomous-dev-homelab-<version>.tgz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PLUGIN_DIR"

# Ensure build is fresh
echo "[package] Building..."
bash scripts/build.sh

# Run secret scan on dist before packaging
echo "[package] Scanning for secrets..."
bash scripts/secret-scan.sh dist/

VERSION=$(node -e "const p=require('./package.json'); process.stdout.write(p.version)")
TARBALL="dist/autonomous-dev-homelab-${VERSION}.tgz"

echo "[package] Creating tarball: $TARBALL"
mkdir -p dist

# Create tarball with plugin contents
tar -czf "$TARBALL" \
  --transform 's|^|autonomous-dev-homelab/|' \
  dist/ \
  package.json \
  README.md \
  2>/dev/null

echo "[package] Package created: $TARBALL"
