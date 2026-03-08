#!/usr/bin/env bash
# install-ecosystem.sh — one-command installer for Super Subagents companion tools
#
# Installs:
#   1. Companion MCP servers (crash-think-tool, morph, skills-as-context,
#      research-powerpack, ask-questions) into Claude Code
#   2. Required skills (planning, playwright-cli, research-powerpack)
#      from yigitkonur/skills-by-yigitkonur via skills.sh
#   3. PostToolUse notification hook (delegates to install-hooks.sh)
#
# Usage:
#   pnpm install-ecosystem                 # from repo
#   npx super-agents-install-ecosystem     # after npm install
#   bash scripts/install-ecosystem.sh [--uninstall] [--check]
#
# Flags:
#   --check       Show status without modifying anything
#   --uninstall   Remove all companion MCP servers and skills
#   --skip-hooks  Skip PostToolUse hook installation
#   --skip-mcp    Skip MCP server installation
#   --skip-skills Skip skill installation

set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SCRIPT="${SCRIPT_DIR}/install-hooks.sh"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_JSON="${HOME}/.claude.json"
MODE="${1:-install}"

# ── Helpers ──────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
dim()    { printf '\033[0;90m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Skip flags ───────────────────────────────────────────────────────────────

SKIP_HOOKS=false
SKIP_MCP=false
SKIP_SKILLS=false

for arg in "$@"; do
  case "$arg" in
    --skip-hooks)  SKIP_HOOKS=true ;;
    --skip-mcp)    SKIP_MCP=true ;;
    --skip-skills) SKIP_SKILLS=true ;;
    --check)       MODE="--check" ;;
    --uninstall)   MODE="--uninstall" ;;
  esac
done

# ── MCP Servers ──────────────────────────────────────────────────────────────

# Server definitions: name|package|env_hint
MCP_SERVERS=(
  "crash-think-tool|crash-mcp|"
  "morph|@morphllm/morphmcp|MORPH_API_KEY"
  "skills-as-context|mcp-skills-as-context|"
  "research-powerpack|mcp-researchpowerpack|SERPER_API_KEY"
  "ask-questions|mcp-vibepowerpack|"
)

# ── Skills ───────────────────────────────────────────────────────────────────

REQUIRED_SKILLS=(
  "yigitkonur/skills-by-yigitkonur/planning"
  "yigitkonur/skills-by-yigitkonur/playwright-cli"
  "yigitkonur/skills-by-yigitkonur/research-powerpack"
)

# ── Preflight ────────────────────────────────────────────────────────────────

check_prerequisites() {
  local ok=true

  # Claude Code directory
  if [ -d "$CLAUDE_DIR" ]; then
    green "  [ok] ~/.claude directory exists"
  else
    red   "  [!!] ~/.claude directory not found — is Claude Code installed?"
    ok=false
  fi

  # claude CLI
  if command -v claude &>/dev/null; then
    green "  [ok] claude CLI found: $(command -v claude)"
  else
    red   "  [!!] claude CLI not found in PATH"
    ok=false
  fi

  # npx
  if command -v npx &>/dev/null; then
    green "  [ok] npx found: $(command -v npx)"
  else
    red   "  [!!] npx not found — install Node.js >= 18"
    ok=false
  fi

  # jq (for hooks)
  if command -v jq &>/dev/null; then
    green "  [ok] jq found"
  else
    yellow "  [!!] jq not found — hooks installer needs it (brew install jq)"
  fi

  if [ "$ok" = false ]; then
    die "Prerequisites not met. Fix the issues above and retry."
  fi
}

# ── Check status ─────────────────────────────────────────────────────────────

check_status() {
  bold "Ecosystem status"
  echo ""

  bold "MCP Servers:"
  for entry in "${MCP_SERVERS[@]}"; do
    IFS='|' read -r name package env_hint <<< "$entry"
    if [ -f "$CLAUDE_JSON" ] && python3 -c "
import json, sys
d = json.load(open('$CLAUDE_JSON'))
sys.exit(0 if '$name' in d.get('mcpServers', {}) else 1)
" 2>/dev/null; then
      green "  [installed] $name ($package)"
    else
      yellow "  [missing]   $name ($package)"
      if [ -n "$env_hint" ]; then
        dim "              requires: $env_hint"
      fi
    fi
  done

  echo ""
  bold "Skills:"
  for skill in "${REQUIRED_SKILLS[@]}"; do
    local skill_name="${skill##*/}"
    # Check if skill directory exists in .claude/skills
    if [ -d "${CLAUDE_DIR}/skills/${skill_name}" ] || [ -d "${CLAUDE_DIR}/commands/${skill_name}" ]; then
      green "  [installed] $skill_name"
    else
      yellow "  [missing]   $skill_name"
      dim "              install: npx skills add $skill"
    fi
  done

  echo ""
  bold "Hooks:"
  if [ -f "${HOOKS_SCRIPT}" ]; then
    bash "${HOOKS_SCRIPT}" --check 2>/dev/null || true
  else
    yellow "  [unknown] hooks installer not found at ${HOOKS_SCRIPT}"
  fi
}

# ── Install MCP servers ─────────────────────────────────────────────────────

install_mcp_servers() {
  bold "Installing MCP servers..."
  echo ""

  for entry in "${MCP_SERVERS[@]}"; do
    IFS='|' read -r name package env_hint <<< "$entry"

    # Check if already installed
    if [ -f "$CLAUDE_JSON" ] && python3 -c "
import json, sys
d = json.load(open('$CLAUDE_JSON'))
sys.exit(0 if '$name' in d.get('mcpServers', {}) else 1)
" 2>/dev/null; then
      green "  [skip] $name — already installed"
      continue
    fi

    # Check for required env var
    if [ -n "$env_hint" ]; then
      eval "env_val=\${$env_hint:-}"
      if [ -z "$env_val" ]; then
        yellow "  [skip] $name — $env_hint not set in environment"
        dim "         Set $env_hint and re-run, or install manually:"
        dim "         claude mcp add $name -e $env_hint=your-key -- npx -y ${package}@latest"
        continue
      fi
      claude mcp add "$name" -e "${env_hint}=${env_val}" -- npx -y "${package}@latest" 2>/dev/null \
        && green "  [ok] $name installed" \
        || red "  [!!] $name failed to install"
    else
      claude mcp add "$name" -- npx -y "${package}@latest" 2>/dev/null \
        && green "  [ok] $name installed" \
        || red "  [!!] $name failed to install"
    fi
  done
}

# ── Install skills ───────────────────────────────────────────────────────────

install_skills() {
  bold "Installing skills..."
  echo ""

  if ! command -v npx &>/dev/null; then
    red "  [!!] npx not found — cannot install skills"
    return 1
  fi

  for skill in "${REQUIRED_SKILLS[@]}"; do
    local skill_name="${skill##*/}"
    green "  Installing $skill_name..."
    npx skills add "$skill" 2>/dev/null \
      && green "  [ok] $skill_name installed" \
      || yellow "  [!!] $skill_name — install failed (try manually: npx skills add $skill)"
  done
}

# ── Uninstall ────────────────────────────────────────────────────────────────

uninstall_all() {
  bold "Uninstalling ecosystem..."
  echo ""

  if [ "$SKIP_MCP" = false ]; then
    bold "Removing MCP servers..."
    for entry in "${MCP_SERVERS[@]}"; do
      IFS='|' read -r name package env_hint <<< "$entry"
      claude mcp remove "$name" 2>/dev/null \
        && green "  [ok] $name removed" \
        || dim "  [skip] $name — not found"
    done
  fi

  if [ "$SKIP_SKILLS" = false ]; then
    echo ""
    bold "Removing skills..."
    for skill in "${REQUIRED_SKILLS[@]}"; do
      local skill_name="${skill##*/}"
      npx skills remove "$skill_name" 2>/dev/null \
        && green "  [ok] $skill_name removed" \
        || dim "  [skip] $skill_name — not found or remove not supported"
    done
  fi

  if [ "$SKIP_HOOKS" = false ] && [ -f "${HOOKS_SCRIPT}" ]; then
    echo ""
    bold "Removing hooks..."
    bash "${HOOKS_SCRIPT}" --uninstall 2>/dev/null || true
  fi

  echo ""
  green "Ecosystem uninstalled."
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo ""
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bold "  Super Subagents — Ecosystem Installer"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

case "$MODE" in
  --check)
    check_status
    ;;

  --uninstall)
    uninstall_all
    ;;

  install)
    check_prerequisites
    echo ""

    if [ "$SKIP_MCP" = false ]; then
      install_mcp_servers
      echo ""
    fi

    if [ "$SKIP_SKILLS" = false ]; then
      install_skills
      echo ""
    fi

    if [ "$SKIP_HOOKS" = false ] && [ -f "${HOOKS_SCRIPT}" ]; then
      bold "Installing hooks..."
      bash "${HOOKS_SCRIPT}" || true
      echo ""
    fi

    bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    green "  Ecosystem install complete!"
    echo ""
    dim "  Run with --check to verify status"
    dim "  Run with --uninstall to remove everything"
    bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  *)
    die "Unknown mode: $MODE (use install, --check, or --uninstall)"
    ;;
esac
