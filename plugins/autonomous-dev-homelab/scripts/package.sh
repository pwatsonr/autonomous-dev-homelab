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

# Stage files into a named subdirectory so the tarball has the correct
# top-level prefix (autonomous-dev-homelab/). This avoids relying on
# --transform (GNU tar only) and works with both BSD tar (macOS) and
# GNU tar (Linux CI).
STAGE_DIR="$(mktemp -d)"
STAGE_PKG="${STAGE_DIR}/autonomous-dev-homelab"
mkdir -p "$STAGE_PKG"

cp -r dist/ "$STAGE_PKG/dist"
cp package.json "$STAGE_PKG/package.json"
[ -f README.md ] && cp README.md "$STAGE_PKG/README.md" || true

# Include JSON schemas required at runtime (inventory-v1.json etc).
# The compiled JS resolves them as '../../schemas/<name>.json' relative to
# dist/<module>/, which maps to <install-root>/schemas/<name>.json.
if [ -d schemas ]; then
  cp -r schemas/ "$STAGE_PKG/schemas"
fi

tar -czf "$TARBALL" -C "$STAGE_DIR" autonomous-dev-homelab

# Clean up staging area
rm -rf "$STAGE_DIR"

echo "[package] Package created: $TARBALL"
