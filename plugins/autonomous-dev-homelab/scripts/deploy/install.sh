#!/usr/bin/env bash
# Install the autonomous-dev-homelab plugin from a tarball.
# SPEC: REQ-000055 TASK-012a.
#
# Usage: bash scripts/deploy/install.sh <tarball.tgz>
#
# - Extracts tarball to ~/.claude/plugins/autonomous-dev-homelab-<version>/
# - Creates symlink ~/.claude/plugins/autonomous-dev-homelab → above
# - Appends install log entry to ~/.autonomous-dev-homelab/installs.log

set -euo pipefail

TARBALL="${1:-}"
if [ -z "$TARBALL" ]; then
  echo "Usage: $0 <tarball.tgz>" >&2
  exit 1
fi

if [ ! -f "$TARBALL" ]; then
  echo "Error: tarball not found: $TARBALL" >&2
  exit 1
fi

HOME="${HOME:-$HOME}"
PLUGINS_DIR="${HOME}/.claude/plugins"
LOG_DIR="${HOME}/.autonomous-dev-homelab"
LOG_FILE="${LOG_DIR}/installs.log"

# Extract version from tarball filename
TARBALL_BASENAME="$(basename "$TARBALL")"
VERSION="${TARBALL_BASENAME#autonomous-dev-homelab-}"
VERSION="${VERSION%.tgz}"
if [ -z "$VERSION" ] || [ "$VERSION" = "$TARBALL_BASENAME" ]; then
  # Try to read from package.json inside tarball
  VERSION=$(tar -xzf "$TARBALL" --to-stdout "autonomous-dev-homelab/package.json" 2>/dev/null | grep '"version"' | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/' || echo "0.0.0")
fi

INSTALL_DIR="${PLUGINS_DIR}/autonomous-dev-homelab-${VERSION}"
SYMLINK="${PLUGINS_DIR}/autonomous-dev-homelab"

echo "[install] Installing autonomous-dev-homelab ${VERSION}..."
mkdir -p "$PLUGINS_DIR"
mkdir -p "$LOG_DIR"

# Extract tarball
mkdir -p "$INSTALL_DIR"
tar -xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1

# Install production Node.js dependencies (the tarball does not bundle node_modules).
# Use --ignore-scripts to skip lifecycle hooks that may require a full dev environment.
echo "[install] Installing production dependencies..."
(cd "$INSTALL_DIR" && npm install --production --ignore-scripts --no-audit --no-fund 2>&1 | sed 's/^/[install:npm]  /')

# Atomic symlink flip (idempotent)
ln -sfn "$INSTALL_DIR" "$SYMLINK"

echo "[install] Plugin installed to $INSTALL_DIR"
echo "[install] Symlink: $SYMLINK -> $INSTALL_DIR"

# Append to install log
INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"op":"install","version":"%s","installed_at":"%s","target":"%s"}\n' \
  "$VERSION" "$INSTALLED_AT" "$INSTALL_DIR" >> "$LOG_FILE"

echo "[install] Done. Log entry written to $LOG_FILE"
