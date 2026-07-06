#!/usr/bin/env bash
# Scan a directory for secret material.
# SPEC: REQ-000055 TASK-002 (T002-4, T002-5).
#
# Usage: bash scripts/secret-scan.sh <directory>
# Exit 0 if clean, non-zero if secrets found.

set -euo pipefail

TARGET="${1:-.}"

PATTERNS=(
  "BEGIN.*PRIVATE KEY"
  "hvs\.[A-Za-z0-9._-]+"
  "AKIA[0-9A-Z]{16}"
  "xoxb-[A-Za-z0-9-]+"
)

FOUND=0

for pattern in "${PATTERNS[@]}"; do
  # Exclusions:
  #   node_modules  — third-party deps
  #   .test.        — test fixtures / snapshots
  #   # example / # placeholder — doc comments
  #   redactor      — the redactor module itself carries these patterns as
  #                   regex literals used to *strip* secrets; they are not
  #                   credential values. (redactor.ts / redactor.js)
  if grep -rE "$pattern" "$TARGET" --include="*.js" --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.env" 2>/dev/null \
    | grep -v "node_modules" \
    | grep -v ".test." \
    | grep -v "# example" \
    | grep -v "# placeholder" \
    | grep -v "redactor" \
    | grep -q .; then
    echo "[secret-scan] FAIL: Pattern '$pattern' matched in $TARGET"
    FOUND=1
  fi
done

if [ $FOUND -eq 0 ]; then
  echo "[secret-scan] PASS: No secrets found in $TARGET"
  exit 0
else
  echo "[secret-scan] FAIL: Secret patterns found. Fix before packaging."
  exit 1
fi
