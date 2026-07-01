#!/usr/bin/env bash
# Rollback the autonomous-dev-homelab plugin to a previous version.
# SPEC: REQ-000055 TASK-012b.
#
# Usage: bash scripts/deploy/rollback.sh [<target-version>]
#
# - If no target version given, rolls back to the second-newest version.
# - Flips the symlink atomically with `ln -sfn`.
# - Appends rollback log entry to ~/.autonomous-dev-homelab/installs.log.

set -euo pipefail

HOME="${HOME:-$HOME}"
PLUGINS_DIR="${HOME}/.claude/plugins"
LOG_DIR="${HOME}/.autonomous-dev-homelab"
LOG_FILE="${LOG_DIR}/installs.log"
SYMLINK="${PLUGINS_DIR}/autonomous-dev-homelab"

# Find current version
if [ ! -L "$SYMLINK" ]; then
  echo "Error: No plugin symlink found at $SYMLINK" >&2
  exit 1
fi

CURRENT_TARGET="$(readlink "$SYMLINK")"
CURRENT_VERSION="$(basename "$CURRENT_TARGET" | sed 's/autonomous-dev-homelab-//')"
echo "[rollback] Current version: $CURRENT_VERSION"

TARGET_VERSION="${1:-}"
TARGET_DIR=""

if [ -n "$TARGET_VERSION" ]; then
  TARGET_DIR="${PLUGINS_DIR}/autonomous-dev-homelab-${TARGET_VERSION}"
  if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: Target version directory not found: $TARGET_DIR" >&2
    exit 1
  fi
else
  # Roll back to second-newest version (sorted by mtime desc)
  mapfile -t DIRS < <(ls -dt "${PLUGINS_DIR}/autonomous-dev-homelab-"* 2>/dev/null)
  if [ ${#DIRS[@]} -lt 2 ]; then
    echo "Error: No previous version to roll back to" >&2
    exit 1
  fi
  TARGET_DIR="${DIRS[1]}"
  TARGET_VERSION="$(basename "$TARGET_DIR" | sed 's/autonomous-dev-homelab-//')"
fi

echo "[rollback] Rolling back to: $TARGET_VERSION ($TARGET_DIR)"

# Atomic symlink flip
ln -sfn "$TARGET_DIR" "$SYMLINK"

# Append rollback log entry
ROLLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$LOG_DIR"
printf '{"op":"rollback","version":"%s","installed_at":"%s","target":"%s","rolled_back_from":"%s"}\n' \
  "$TARGET_VERSION" "$ROLLED_AT" "$TARGET_DIR" "$CURRENT_VERSION" >> "$LOG_FILE"

echo "[rollback] Done. Now at: $TARGET_VERSION"
