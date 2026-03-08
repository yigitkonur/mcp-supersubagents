#!/usr/bin/env bash
# super-agents-hook.sh — PostToolUse hook for Claude Code
#
# Reads unseen task events from {CWD}/.super-agents/hook-state.json
# and outputs hookSpecificOutput with additionalContext for Claude Code
# to inject into the conversation. Marks events as seen after output.
#
# Setup in ~/.claude/settings.json:
# {
#   "hooks": {
#     "PostToolUse": [{
#       "hooks": [{"type": "command", "command": "/path/to/super-agents-hook.sh"}]
#     }]
#   }
# }

set -euo pipefail

STATE_FILE="${PWD}/.super-agents/hook-state.json"

# Exit silently if state file doesn't exist
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Prefer jq, fall back to python3
if command -v jq >/dev/null 2>&1; then
  USE_JQ=1
else
  USE_JQ=0
  if ! command -v python3 >/dev/null 2>&1; then
    exit 0
  fi
fi

if [ "$USE_JQ" = "1" ]; then
  # Extract unseen events (seenAt == null)
  UNSEEN=$(jq -r '
    [.events | to_entries[] | select(.value.seenAt == null) | .value] | length
  ' "$STATE_FILE" 2>/dev/null || echo "0")

  if [ "$UNSEEN" = "0" ]; then
    exit 0
  fi

  # Build context string from unseen events
  CONTEXT=$(jq -r '
    .events | to_entries[]
    | select(.value.seenAt == null)
    | .value
    | if .type == "input_required" then
        "[SUPER-AGENT QUESTION] Task \(.taskId) is asking: \"\(.question // "unknown")\""
        + if (.choices // [] | length) > 0 then
            " Options: " + ([.choices[] | tostring] | to_entries | map("\(.key + 1). \(.value)") | join(", "))
            + ". Use answer-agent to respond."
          else
            ". Use answer-agent to respond."
          end
      else
        "[SUPER-AGENT \(.type | ascii_upcase)] Task \(.taskId) has \(.status)."
        + if .outputFile then " Output: \(.outputFile)" else "" end
      end
  ' "$STATE_FILE" 2>/dev/null || true)

  if [ -z "$CONTEXT" ]; then
    exit 0
  fi

  # Produce output FIRST — if this fails, events stay unseen and retry next time
  ESCAPED=$(printf '%s' "$CONTEXT" | jq -Rs . 2>/dev/null || printf '"%s"' "$CONTEXT")
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$ESCAPED"

  # Mark events as seen AFTER successful output
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  UPDATED=$(jq --arg now "$NOW" '
    .events |= with_entries(
      if .value.seenAt == null then .value.seenAt = $now else . end
    )
  ' "$STATE_FILE" 2>/dev/null || true)

  if [ -n "$UPDATED" ]; then
    TMP_FILE="${STATE_FILE}.tmp.$$"
    printf '%s\n' "$UPDATED" > "$TMP_FILE"
    mv "$TMP_FILE" "$STATE_FILE"
  fi

else
  # Python3 fallback — uses heredoc to avoid shell expansion / injection
  python3 - "$STATE_FILE" << 'PYEOF'
import json, sys, os
from datetime import datetime, timezone

state_file = sys.argv[1]
try:
    with open(state_file, 'r') as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

events = data.get('events', {})
unseen = {k: v for k, v in events.items() if v.get('seenAt') is None}

if not unseen:
    sys.exit(0)

lines = []
for tid, ev in unseen.items():
    if ev.get('type') == 'input_required':
        line = f'[SUPER-AGENT QUESTION] Task {ev["taskId"]} is asking: "{ev.get("question", "unknown")}"'
        choices = ev.get('choices', [])
        if choices:
            opts = ', '.join(f'{i+1}. {c}' for i, c in enumerate(choices))
            line += f' Options: {opts}. Use answer-agent to respond.'
        else:
            line += ' Use answer-agent to respond.'
    else:
        etype = ev.get('type', 'unknown').upper()
        line = f'[SUPER-AGENT {etype}] Task {ev["taskId"]} has {ev.get("status", "unknown")}.'
        if ev.get('outputFile'):
            line += f' Output: {ev["outputFile"]}'
    lines.append(line)

context = '\n'.join(lines)

# Produce output FIRST — if this fails, events stay unseen and retry next time
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': context}}))
sys.stdout.flush()

# Mark events as seen AFTER successful output
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
for k in unseen:
    events[k]['seenAt'] = now

try:
    tmp = state_file + f'.tmp.{os.getpid()}'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    os.rename(tmp, state_file)
except Exception:
    pass
PYEOF
fi
