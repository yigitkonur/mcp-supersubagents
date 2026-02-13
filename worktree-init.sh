#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# worktree-init.sh  --  Bootstrap a git-worktree checkout of mcp-supersubagents
#
# Copies environment/config files from the main repo and installs dependencies.
# Idempotent: safe to run multiple times.
###############################################################################

MAIN_REPO="/Users/yigitkonur/dev/my-mcp/mcp-supersubagents"

# Resolve the worktree directory (where this script lives).
WORKTREE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> worktree-init.sh"
echo "    Main repo : ${MAIN_REPO}"
echo "    Worktree  : ${WORKTREE_DIR}"
echo ""

# --------------------------------------------------------------------------- #
# 1. Copy .env (if present in main repo)
# --------------------------------------------------------------------------- #
if [[ -f "${MAIN_REPO}/.env" ]]; then
  cp -v "${MAIN_REPO}/.env" "${WORKTREE_DIR}/.env"
  echo "    .env copied."
else
  echo "    .env not found in main repo -- skipping."
fi

# --------------------------------------------------------------------------- #
# 2. Copy .claude/settings.local.json (if present in main repo)
# --------------------------------------------------------------------------- #
if [[ -f "${MAIN_REPO}/.claude/settings.local.json" ]]; then
  mkdir -p "${WORKTREE_DIR}/.claude"
  cp -v "${MAIN_REPO}/.claude/settings.local.json" "${WORKTREE_DIR}/.claude/settings.local.json"
  echo "    .claude/settings.local.json copied."
else
  echo "    .claude/settings.local.json not found in main repo -- skipping."
fi

# --------------------------------------------------------------------------- #
# 3. Install dependencies with npm
# --------------------------------------------------------------------------- #
echo ""
echo "==> Installing dependencies (npm ci) ..."
cd "${WORKTREE_DIR}"

# Use npm ci for reproducible installs from the lockfile.
# Falls back to npm install if package-lock.json is somehow missing.
if [[ -f "package-lock.json" ]]; then
  npm ci --no-audit --no-fund
else
  echo "    WARNING: package-lock.json missing -- falling back to npm install"
  npm install --no-audit --no-fund
fi

# --------------------------------------------------------------------------- #
# 4. Build the project
# --------------------------------------------------------------------------- #
echo ""
echo "==> Building project (npm run build) ..."
npm run build

echo ""
echo "==> worktree-init.sh complete."
