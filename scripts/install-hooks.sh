#!/usr/bin/env bash
# install-hooks.sh — one-command PostToolUse hook installer for Claude Code
#
# Usage:
#   pnpm install-hooks          # from repo
#   npx super-agents-hooks      # after npm install
#   bash scripts/install-hooks.sh [--uninstall] [--check]
#
# What it does:
#   1. Verifies Claude Code environment (~/.claude, settings.json)
#   2. Locates the super-agents-hook.sh script
#   3. Merges a PostToolUse hook entry into settings.json (idempotent)
#   4. Reports system status
#
# Safe: reads existing settings first, merges without clobbering, backs up before writing.

set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="${SCRIPT_DIR}/super-agents-hook.sh"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS_FILE="${CLAUDE_DIR}/settings.json"
MODE="${1:-install}"  # install | --uninstall | --check

# ── Helpers ──────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
dim()    { printf '\033[0;90m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Preflight checks ────────────────────────────────────────────────────────

preflight() {
  local ok=0 warn=0

  bold "Preflight checks"
  echo ""

  # 1. Claude Code directory
  if [ -d "$CLAUDE_DIR" ]; then
    green "  [ok] ~/.claude directory exists"
  else
    red   "  [!!] ~/.claude directory not found — is Claude Code installed?"
    ok=1
  fi

  # 2. jq available (required for safe JSON merge)
  if command -v jq >/dev/null 2>&1; then
    green "  [ok] jq $(jq --version 2>/dev/null || echo '(unknown version)')"
  else
    red   "  [!!] jq not found — required for safe JSON merge"
    dim   "       Install: brew install jq  /  apt install jq  /  choco install jq"
    ok=1
  fi

  # 3. Hook script exists
  if [ -f "$HOOK_SCRIPT" ]; then
    green "  [ok] Hook script found: ${HOOK_SCRIPT}"
  else
    red   "  [!!] Hook script not found at: ${HOOK_SCRIPT}"
    ok=1
  fi

  # 4. settings.json exists and is valid JSON
  if [ -f "$SETTINGS_FILE" ]; then
    if jq empty "$SETTINGS_FILE" 2>/dev/null; then
      green "  [ok] settings.json is valid JSON"
    else
      red   "  [!!] settings.json exists but is not valid JSON"
      ok=1
    fi
  else
    yellow "  [--] settings.json does not exist (will be created)"
    warn=1
  fi

  # 5. claude CLI in PATH (informational)
  if command -v claude >/dev/null 2>&1; then
    local ver
    ver=$(claude --version 2>/dev/null | head -1 || echo "unknown")
    green "  [ok] claude CLI in PATH: ${ver}"
  else
    yellow "  [--] claude CLI not in PATH (not required for hooks)"
    warn=1
  fi

  # 6. python3 available (fallback for hook script)
  if command -v python3 >/dev/null 2>&1; then
    green "  [ok] python3 available (hook script fallback)"
  else
    yellow "  [--] python3 not available (jq is the primary path, this is fine)"
    warn=1
  fi

  # 7. Existing hooks
  if [ -f "$SETTINGS_FILE" ] && jq -e '.hooks' "$SETTINGS_FILE" >/dev/null 2>&1; then
    local hook_count
    hook_count=$(jq '[.hooks | to_entries[] | .value | length] | add // 0' "$SETTINGS_FILE" 2>/dev/null || echo "0")
    yellow "  [--] ${hook_count} existing hook(s) found (will be preserved)"
  fi

  echo ""

  if [ "$ok" -ne 0 ]; then
    return 1
  fi
  return 0
}

# ── Check: already installed? ────────────────────────────────────────────────

is_installed() {
  [ -f "$SETTINGS_FILE" ] || return 1
  local count
  count=$(jq -r --arg cmd "$HOOK_SCRIPT" '
    [.hooks.PostToolUse // [] | .[] | select(.command == $cmd)] | length
  ' "$SETTINGS_FILE" 2>/dev/null || echo "0")
  [ "$count" != "0" ]
}

# ── Install ──────────────────────────────────────────────────────────────────

do_install() {
  preflight || die "Preflight failed — fix the issues above and retry"

  # Make hook script executable
  chmod +x "$HOOK_SCRIPT"

  # Already installed? (idempotent)
  if is_installed; then
    green "Hook already installed — nothing to do."
    dim   "  Script:   ${HOOK_SCRIPT}"
    dim   "  Settings: ${SETTINGS_FILE}"
    return 0
  fi

  # Create settings.json if missing
  if [ ! -f "$SETTINGS_FILE" ]; then
    mkdir -p "$CLAUDE_DIR"
    echo '{}' > "$SETTINGS_FILE"
  fi

  # Backup before modifying
  cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak"
  dim "  Backed up to ${SETTINGS_FILE}.bak"

  # Merge hook entry (preserves all existing keys and other hooks)
  local updated
  updated=$(jq --arg cmd "$HOOK_SCRIPT" '
    .hooks.PostToolUse = (
      [(.hooks.PostToolUse // [])[] | select(.command != $cmd)]
      + [{"matcher": ".*", "command": $cmd}]
    )
  ' "$SETTINGS_FILE")

  printf '%s\n' "$updated" > "$SETTINGS_FILE"

  echo ""
  green "PostToolUse hook installed successfully!"
  echo ""
  dim   "  Hook script: ${HOOK_SCRIPT}"
  dim   "  Settings:    ${SETTINGS_FILE}"
  dim   "  Backup:      ${SETTINGS_FILE}.bak"
  echo ""
  bold  "What happens now:"
  echo  "  After every tool call, Claude Code runs the hook script."
  echo  "  When a sub-agent completes, fails, or asks a question,"
  echo  "  the notification appears inline in your conversation —"
  echo  "  no need to poll task:///all manually."
  echo ""
  dim   "  To remove: bash ${SCRIPT_DIR}/install-hooks.sh --uninstall"
}

# ── Uninstall ────────────────────────────────────────────────────────────────

do_uninstall() {
  if [ ! -f "$SETTINGS_FILE" ]; then
    yellow "No settings.json found — nothing to uninstall."
    return 0
  fi

  if ! is_installed; then
    yellow "Hook not found in settings.json — nothing to uninstall."
    return 0
  fi

  cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak"

  local updated
  updated=$(jq --arg cmd "$HOOK_SCRIPT" '
    .hooks.PostToolUse = [(.hooks.PostToolUse // [])[] | select(.command != $cmd)]
    | if (.hooks.PostToolUse | length) == 0 then del(.hooks.PostToolUse) else . end
    | if (.hooks | length) == 0 then del(.hooks) else . end
  ' "$SETTINGS_FILE")

  printf '%s\n' "$updated" > "$SETTINGS_FILE"

  green "Hook removed from ${SETTINGS_FILE}"
  dim   "  Backup: ${SETTINGS_FILE}.bak"
}

# ── Check only ───────────────────────────────────────────────────────────────

do_check() {
  preflight || true

  echo ""
  if is_installed; then
    green "Hook status: INSTALLED"
    dim   "  Script: ${HOOK_SCRIPT}"
  else
    yellow "Hook status: NOT INSTALLED"
    dim   "  Run: bash ${SCRIPT_DIR}/install-hooks.sh"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "$MODE" in
  install|--install|-i)
    do_install
    ;;
  --uninstall|-u|uninstall|remove)
    do_uninstall
    ;;
  --check|-c|check|status)
    do_check
    ;;
  --help|-h|help)
    bold "super-agents hook installer"
    echo ""
    echo "Usage: bash $0 [command]"
    echo ""
    echo "Commands:"
    echo "  install      Install PostToolUse hook (default)"
    echo "  --uninstall  Remove the hook from settings.json"
    echo "  --check      Check system status without modifying anything"
    echo "  --help       Show this help"
    ;;
  *)
    die "Unknown command: ${MODE}. Use --help for usage."
    ;;
esac
