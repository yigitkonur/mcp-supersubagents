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
#
# Re-install safe:
#   - MCP servers: skipped if already present in ~/.claude.json (env vars preserved)
#   - Skills: skipped if already installed (checked via npx skills list)
#   - Hooks: delegated to install-hooks.sh which is idempotent
#   - Running twice is always safe and produces the same result

set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SCRIPT="${SCRIPT_DIR}/install-hooks.sh"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_JSON="${HOME}/.claude.json"

# ── Parse flags ──────────────────────────────────────────────────────────────

MODE="install"
SKIP_HOOKS=false
SKIP_MCP=false
SKIP_SKILLS=false

for arg in "$@"; do
  case "$arg" in
    --skip-hooks)  SKIP_HOOKS=true ;;
    --skip-mcp)    SKIP_MCP=true ;;
    --skip-skills) SKIP_SKILLS=true ;;
    --check|-c|check|status)     MODE="check" ;;
    --uninstall|-u|uninstall)    MODE="uninstall" ;;
    --help|-h|help)              MODE="help" ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
dim()    { printf '\033[0;90m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Definitions ──────────────────────────────────────────────────────────────

# MCP server definitions: name|package|env_keys (comma-separated, empty = none needed)
MCP_SERVERS=(
  "crash-think-tool|crash-mcp|"
  "morph|@morphllm/morphmcp|MORPH_API_KEY"
  "skills-as-context|mcp-skills-as-context|"
  "research-powerpack|mcp-researchpowerpack|SERPER_API_KEY"
  "ask-questions|mcp-vibepowerpack|"
)

# Skills: repo-path|skill-name (skill-name = last segment, used for install check)
REQUIRED_SKILLS=(
  "yigitkonur/skills-by-yigitkonur/planning"
  "yigitkonur/skills-by-yigitkonur/playwright-cli"
  "yigitkonur/skills-by-yigitkonur/research-powerpack"
)

# ── JSON helpers (jq with python3 fallback) ──────────────────────────────────

# Check if a key exists in mcpServers in ~/.claude.json
mcp_server_exists() {
  local name="$1"
  [ -f "$CLAUDE_JSON" ] || return 1

  if command -v jq &>/dev/null; then
    jq -e --arg n "$name" '.mcpServers[$n] != null' "$CLAUDE_JSON" &>/dev/null
  else
    python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    sys.exit(0 if sys.argv[2] in d.get('mcpServers', {}) else 1)
except: sys.exit(1)
" "$CLAUDE_JSON" "$name" 2>/dev/null
  fi
}

# ── Preflight ────────────────────────────────────────────────────────────────

check_prerequisites() {
  local ok=true

  bold "Preflight checks"
  echo ""

  # Claude Code directory
  if [ -d "$CLAUDE_DIR" ]; then
    green "  [ok] ~/.claude directory exists"
  else
    red   "  [!!] ~/.claude directory not found — is Claude Code installed?"
    ok=false
  fi

  # claude CLI
  if command -v claude &>/dev/null; then
    local ver
    ver=$(timeout 5 claude --version 2>/dev/null | head -1 || echo "unknown")
    green "  [ok] claude CLI: ${ver}"
  else
    red   "  [!!] claude CLI not found in PATH"
    ok=false
  fi

  # npx
  if command -v npx &>/dev/null; then
    green "  [ok] npx found"
  else
    red   "  [!!] npx not found — install Node.js >= 18"
    ok=false
  fi

  # jq (preferred) or python3 (fallback)
  if command -v jq &>/dev/null; then
    green "  [ok] jq found"
  elif command -v python3 &>/dev/null; then
    yellow "  [--] jq not found, using python3 fallback"
  else
    red   "  [!!] neither jq nor python3 found — need one for JSON parsing"
    ok=false
  fi

  echo ""

  if [ "$ok" = false ]; then
    die "Prerequisites not met. Fix the issues above and retry."
  fi
}

# ── Check status ─────────────────────────────────────────────────────────────

check_status() {
  bold "Ecosystem status"
  echo ""

  # MCP Servers
  bold "  MCP Servers:"
  for entry in "${MCP_SERVERS[@]}"; do
    IFS='|' read -r name package env_hint <<< "$entry"
    if mcp_server_exists "$name"; then
      green "    [installed] $name ($package)"
    else
      yellow "    [missing]   $name ($package)"
      if [ -n "$env_hint" ]; then
        dim "                requires: $env_hint"
      fi
    fi
  done

  echo ""

  # Skills — check via npx skills list (grep for skill name in output)
  bold "  Skills:"
  local skills_output=""
  if command -v npx &>/dev/null; then
    skills_output=$(timeout 15 npx skills list 2>/dev/null || true)
  fi

  for skill_path in "${REQUIRED_SKILLS[@]}"; do
    local skill_name="${skill_path##*/}"
    # Check both: npx skills list output AND .agents/skills/ directory
    if echo "$skills_output" | grep -q "$skill_name" 2>/dev/null; then
      green "    [installed] $skill_name"
    elif [ -d ".agents/skills/${skill_name}" ] || [ -d "${CLAUDE_DIR}/skills/${skill_name}" ]; then
      green "    [installed] $skill_name (local)"
    else
      yellow "    [missing]   $skill_name"
      dim "                install: npx skills add $skill_path"
    fi
  done

  echo ""

  # Hooks
  bold "  Hooks:"
  if [ -f "${HOOKS_SCRIPT}" ]; then
    bash "${HOOKS_SCRIPT}" --check 2>/dev/null || true
  else
    yellow "    [unknown] hooks installer not found"
  fi
}

# ── Install MCP servers ─────────────────────────────────────────────────────

install_mcp_servers() {
  bold "Installing MCP servers..."
  echo ""

  local installed=0 skipped=0 failed=0

  for entry in "${MCP_SERVERS[@]}"; do
    IFS='|' read -r name package env_hint <<< "$entry"

    # Already configured? Skip entirely — don't touch existing env vars
    if mcp_server_exists "$name"; then
      green "  [skip] $name — already configured"
      skipped=$((skipped + 1))
      continue
    fi

    # Build the claude mcp add command with env vars if available
    local -a cmd_args=("mcp" "add" "$name")
    local has_required_env=true

    if [ -n "$env_hint" ]; then
      # Check each required env var (comma-separated)
      IFS=',' read -ra env_keys <<< "$env_hint"
      for ekey in "${env_keys[@]}"; do
        local eval_val="${!ekey:-}"
        if [ -n "$eval_val" ]; then
          cmd_args+=("-e" "${ekey}=${eval_val}")
        else
          has_required_env=false
        fi
      done
    fi

    if [ "$has_required_env" = false ]; then
      yellow "  [skip] $name — required env var(s) not set: $env_hint"
      dim "         Set them in your shell and re-run, or install manually:"
      dim "         claude mcp add $name -e $env_hint=your-key -- npx -y ${package}@latest"
      skipped=$((skipped + 1))
      continue
    fi

    cmd_args+=("--" "npx" "-y" "${package}@latest")

    if claude "${cmd_args[@]}" 2>/dev/null; then
      green "  [ok] $name installed"
      installed=$((installed + 1))
    else
      red "  [!!] $name — install failed"
      dim "       Try manually: claude mcp add $name -- npx -y ${package}@latest"
      failed=$((failed + 1))
    fi
  done

  echo ""
  dim "  MCP servers: $installed installed, $skipped skipped, $failed failed"
}

# ── Install skills ───────────────────────────────────────────────────────────

install_skills() {
  bold "Installing skills..."
  echo ""

  if ! command -v npx &>/dev/null; then
    red "  [!!] npx not found — cannot install skills"
    return 1
  fi

  # Get current skill list once (avoid repeated slow calls)
  local skills_output=""
  skills_output=$(timeout 15 npx skills list 2>/dev/null || true)

  local installed=0 skipped=0 failed=0

  for skill_path in "${REQUIRED_SKILLS[@]}"; do
    local skill_name="${skill_path##*/}"

    # Already installed? Check npx skills list output AND local directories
    if echo "$skills_output" | grep -q "$skill_name" 2>/dev/null; then
      green "  [skip] $skill_name — already installed"
      skipped=$((skipped + 1))
      continue
    fi

    if [ -d ".agents/skills/${skill_name}" ] || [ -d "${CLAUDE_DIR}/skills/${skill_name}" ]; then
      green "  [skip] $skill_name — already installed (local)"
      skipped=$((skipped + 1))
      continue
    fi

    # Install with -a claude-code -y for non-interactive
    if timeout 30 npx skills add "$skill_path" -a claude-code -y 2>/dev/null; then
      green "  [ok] $skill_name installed"
      installed=$((installed + 1))
    else
      yellow "  [!!] $skill_name — auto-install failed, trying interactive..."
      if timeout 30 npx skills add "$skill_path" 2>/dev/null; then
        green "  [ok] $skill_name installed (interactive)"
        installed=$((installed + 1))
      else
        red "  [!!] $skill_name — install failed"
        dim "       Try manually: npx skills add $skill_path"
        failed=$((failed + 1))
      fi
    fi
  done

  echo ""
  dim "  Skills: $installed installed, $skipped skipped, $failed failed"
}

# ── Install hooks (delegates to install-hooks.sh) ───────────────────────────

install_hooks() {
  bold "Installing hooks..."
  echo ""

  if [ ! -f "${HOOKS_SCRIPT}" ]; then
    yellow "  [skip] hooks installer not found at ${HOOKS_SCRIPT}"
    return 0
  fi

  # install-hooks.sh is already idempotent — safe to call repeatedly
  bash "${HOOKS_SCRIPT}" install || true
}

# ── Post-install health check ───────────────────────────────────────────────

run_doctor() {
  echo ""
  bold "Running health check..."
  if command -v claude &>/dev/null; then
    timeout 2 claude doctor 2>&1 || true
  else
    dim "  claude CLI not found — skipping doctor"
  fi
}

# ── Uninstall ────────────────────────────────────────────────────────────────

uninstall_all() {
  bold "Uninstalling ecosystem..."
  echo ""

  if [ "$SKIP_MCP" = false ]; then
    bold "  Removing MCP servers..."
    for entry in "${MCP_SERVERS[@]}"; do
      IFS='|' read -r name package env_hint <<< "$entry"
      if mcp_server_exists "$name"; then
        claude mcp remove "$name" 2>/dev/null \
          && green "    [ok] $name removed" \
          || red "    [!!] $name — remove failed"
      else
        dim "    [skip] $name — not installed"
      fi
    done
    echo ""
  fi

  if [ "$SKIP_SKILLS" = false ]; then
    bold "  Removing skills..."
    for skill_path in "${REQUIRED_SKILLS[@]}"; do
      local skill_name="${skill_path##*/}"
      timeout 15 npx skills remove "$skill_name" 2>/dev/null \
        && green "    [ok] $skill_name removed" \
        || dim "    [skip] $skill_name — not installed or remove not supported"
    done
    echo ""
  fi

  if [ "$SKIP_HOOKS" = false ] && [ -f "${HOOKS_SCRIPT}" ]; then
    bold "  Removing hooks..."
    bash "${HOOKS_SCRIPT}" --uninstall 2>/dev/null || true
    echo ""
  fi

  green "Ecosystem uninstalled."
}

# ── Help ─────────────────────────────────────────────────────────────────────

show_help() {
  bold "super-agents ecosystem installer"
  echo ""
  echo "Usage: bash $0 [command] [flags]"
  echo ""
  echo "Commands:"
  echo "  install      Install all companion tools (default)"
  echo "  --check      Show current status without modifying anything"
  echo "  --uninstall  Remove all companion MCP servers, skills, and hooks"
  echo "  --help       Show this help"
  echo ""
  echo "Flags:"
  echo "  --skip-hooks   Skip PostToolUse hook installation"
  echo "  --skip-mcp     Skip MCP server installation"
  echo "  --skip-skills  Skip skill installation"
  echo ""
  echo "MCP servers installed:"
  for entry in "${MCP_SERVERS[@]}"; do
    IFS='|' read -r name package env_hint <<< "$entry"
    if [ -n "$env_hint" ]; then
      echo "  $name ($package) — requires $env_hint"
    else
      echo "  $name ($package)"
    fi
  done
  echo ""
  echo "Skills installed:"
  for skill_path in "${REQUIRED_SKILLS[@]}"; do
    echo "  ${skill_path##*/} (npx skills add $skill_path)"
  done
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo ""
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bold "  Super Subagents — Ecosystem Installer"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

case "$MODE" in
  check)
    check_status
    ;;

  uninstall)
    uninstall_all
    ;;

  help)
    show_help
    ;;

  install)
    check_prerequisites

    if [ "$SKIP_MCP" = false ]; then
      install_mcp_servers
      echo ""
    fi

    if [ "$SKIP_SKILLS" = false ]; then
      install_skills
      echo ""
    fi

    if [ "$SKIP_HOOKS" = false ]; then
      install_hooks
      echo ""
    fi

    run_doctor

    echo ""
    bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    green "  Ecosystem install complete!"
    echo ""
    dim "  Run with --check to verify status"
    dim "  Run with --uninstall to remove everything"
    bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;
esac
