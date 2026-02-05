# Dialogs (alert/confirm/prompt) block ALL other commands

## What happened
```bash
# Triggered an alert:
eval "() => { window.alert('Blocking!'); return 'done'; }"
# Output includes: ### Modal state
# ["alert" dialog with message "Blocking!"]: can be handled by dialog-accept or dialog-dismiss

# Tried to click while dialog is open:
playwright-cli click e9
# ERROR: Tool "browser_click" does not handle the modal state.
```

## The good news
The CLI tells you exactly what's happening:
- `Modal state` section appears in output
- Clear error message pointing to `dialog-accept` or `dialog-dismiss`
- Works for all three types: alert, confirm, prompt

## How to handle
```bash
dialog-accept              # Accept (OK) — for alert/confirm
dialog-accept "value"      # Accept with text — for prompt dialogs
dialog-dismiss             # Dismiss (Cancel) — for confirm/prompt
```

## Why this matters for agents
Some websites trigger dialogs unexpectedly (e.g., "Are you sure you want to leave?"). If an agent doesn't handle the dialog, they're completely stuck — nothing else works until the dialog is dismissed.

## Impact on agent prompt
Agents should know: if commands start failing with "does not handle the modal state", check for a dialog and dismiss/accept it. The CLI output makes this obvious, but the agent needs to know to look for it.
