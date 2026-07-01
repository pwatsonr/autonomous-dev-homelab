#!/usr/bin/env bash
# Upgrade the autonomous-dev-homelab plugin.
# SPEC: REQ-000055 TASK-012b.
#
# Usage: bash scripts/deploy/upgrade.sh <new-tarball.tgz>
#
# - Installs the new version via install.sh
# - Prunes old versions to keep only the 5 most recent
# - Appends upgrade log entry to ~/.autonomous-dev-homelab/installs.log

set -euo pipefail

TARBALL="${1:-}"
if [ -z "$TARBALL" ]; then
  echo "Usage: $0 <new-tarball.tgz>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME="${HOME:-$HOME}"
PLUGINS_DIR="${HOME}/.claude/plugins"
LOG_DIR="${HOME}/.autonomous-dev-homelab"
LOG_FILE="${LOG_DIR}/installs.log"

# Get current version before upgrade
CURRENT_SYMLINK="${PLUGINS_DIR}/autonomous-dev-homelab"
PREV_VERSION=""
if [ -L "$CURRENT_SYMLINK" ]; then
  PREV_TARGET="$(readlink "$CURRENT_SYMLINK")"
  PREV_VERSION="$(basename "$PREV_TARGET" | sed 's/autonomous-dev-homelab-//')"
fi

# Install the new version
bash "$SCRIPT_DIR/install.sh" "$TARBALL"

# Get new version from symlink
NEW_TARGET="$(readlink "${PLUGINS_DIR}/autonomous-dev-homelab")"
NEW_VERSION="$(basename "$NEW_TARGET" | sed 's/autonomous-dev-homelab-//')"

# Prune old versions (keep 5 most recent)
MAX_VERSIONS=5
mapfile -t OLD_DIRS < <(ls -dt "${PLUGINS_DIR}/autonomous-dev-homelab-"* 2>/dev/null | tail -n +$((MAX_VERSIONS + 1)))
for old_dir in "${OLD_DIRS[@]}"; do
  if [ "$old_dir" != "$NEW_TARGET" ]; then
    echo "[upgrade] Removing old version: $old_dir"
    rm -rf "$old_dir"
  fi
done

# Append upgrade log entry
UPGRADED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"op":"upgrade","version":"%s","installed_at":"%s","target":"%s","previous_version":"%s"}\n' \
  "$NEW_VERSION" "$UPGRADED_AT" "$NEW_TARGET" "$PREV_VERSION" >> "$LOG_FILE"

echo "[upgrade] Upgraded from ${PREV_VERSION} to ${NEW_VERSION}"
