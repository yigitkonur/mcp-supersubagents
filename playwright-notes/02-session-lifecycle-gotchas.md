# 02: Session Lifecycle Gotchas

## Sessions Are Daemons

When you run `playwright-cli open`, it spawns a background daemon process:
```
<!-- Daemon for `default` session started with pid 84822. -->
```

This daemon persists between commands. You do NOT need to re-open for each action. The session stays alive until you explicitly stop it.

## Stale Sessions Block Everything

If a session is in a bad state (wrong browser config, crashed, etc.), ALL subsequent commands fail silently or with cryptic errors. The fix:

```bash
playwright-cli session-stop       # stop default session
playwright-cli session-stop-all   # nuclear option: stop ALL sessions
```

Then reconfigure and reopen.

## Session Stop Before Config Changes

Config changes (`config --browser=chromium`, `config --headed`) only take effect on session restart. The pattern:

```bash
playwright-cli session-stop
playwright-cli config --browser=chromium
playwright-cli open https://example.com    # fresh session with new config
```

NOT:
```bash
playwright-cli config --browser=chromium   # IGNORED if session already running
playwright-cli open https://example.com    # uses OLD config
```

## Named Sessions for Isolation

Use `--session=name` to run parallel isolated browsers:
```bash
playwright-cli --session=mobile open https://example.com
playwright-cli --session=desktop open https://example.com
```

Each has its own cookies, storage, and tabs. But the agent should AVOID this complexity — one session, multiple tabs is simpler and more reliable.

## Always Clean Up

Agent must ALWAYS stop sessions when done:
```bash
playwright-cli session-stop-all
```

Orphaned daemons accumulate and consume memory. If the agent crashes mid-test, the session daemon keeps running.

## Key Insight for Agent Steering

Tell the agent: "Use a single default session. If anything goes wrong, `session-stop` and start fresh. Always `session-stop-all` at the end of testing."
