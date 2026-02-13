#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# worktree-init.sh — Bootstrap a git worktree for mcp-supersubagents
#
# Copies untracked config files (.env, .claude/settings.local.json) from the
# main repo, then installs dependencies with npm.  Idempotent — safe to re-run.
#
# Usage:
#   cd /path/to/worktree && bash worktree-init.sh
#   # or
#   bash /path/to/worktree/worktree-init.sh   (auto-detects its own directory)
###############################################################################

MAIN_REPO="/Users/yigitkonur/dev/projects/mcp-supersubagents"

# Resolve the worktree directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_DIR="${SCRIPT_DIR}"

echo "==> Worktree dir : ${WORKTREE_DIR}"
echo "==> Main repo    : ${MAIN_REPO}"
echo ""

# ---- 1. Copy .env if present in main repo ----
if [[ -f "${MAIN_REPO}/.env" ]]; then
  cp -v "${MAIN_REPO}/.env" "${WORKTREE_DIR}/.env"
  echo "    .env copied."
else
  echo "    .env not found in main repo — skipping."
fi

# ---- 2. Copy .claude/settings.local.json if present in main repo ----
if [[ -f "${MAIN_REPO}/.claude/settings.local.json" ]]; then
  mkdir -p "${WORKTREE_DIR}/.claude"
  cp -v "${MAIN_REPO}/.claude/settings.local.json" "${WORKTREE_DIR}/.claude/settings.local.json"
  echo "    .claude/settings.local.json copied."
else
  echo "    .claude/settings.local.json not found in main repo — skipping."
fi

# ---- 3. Install dependencies ----
echo ""
echo "==> Installing npm dependencies ..."
cd "${WORKTREE_DIR}"
npm ci
echo "    npm ci complete."

echo ""
echo "==> Worktree ready at ${WORKTREE_DIR}"
