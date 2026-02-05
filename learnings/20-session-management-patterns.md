# Session management: what agents need to know

## Session lifecycle
```
First command → auto-starts session daemon → browser launches
close (last page) → session stops
Any command after stop → auto-starts NEW session (clean state)
```

## Key commands
```bash
session-list                # See all sessions and their state
session-stop [name]         # Stop a specific session
session-stop-all            # Stop all sessions
session-restart [name]      # Restart (clean browser, keep config)
session-delete [name]       # Delete session data from disk
```

## Named sessions
```bash
playwright-cli --session mobile open https://example.com
playwright-cli --session desktop open https://example.com
```
Named sessions let you run completely isolated browser instances. But this uses more memory than tabs.

## When to use sessions vs tabs

### Use TABS within one session when:
- Testing the same site at different viewports
- Tests share login state / cookies
- Memory efficiency matters (10 agents scenario)
- You want shared localStorage/cookies across test scenarios

### Use separate SESSIONS when:
- Testing completely different sites
- Tests must have isolated cookies/storage
- You need different browser configs (e.g., different --browser)
- One test's state would contaminate another

## The stale session trap
If a previous run crashed or wasn't cleaned up:
```bash
playwright-cli session-stop 2>/dev/null   # Kill stale session
# Then start fresh
```

This is already in the bootstrap section of the prompt. Critical for CI/CD or long-running agent pools.

## Impact on agent prompt
Agents should prefer tabs over sessions for memory efficiency. Session management commands should be used for setup/cleanup, not during active testing. The bootstrap step should always kill stale sessions before starting.
