# close KILLS the session; tab-close just closes a tab

## Initial assumption
I assumed `close` would close the current page/tab, similar to Ctrl+W in a browser.

## What actually happened
```bash
# With only 1 tab open:
playwright-cli close
# Result: "Session 'default' stopped."

# Next command auto-starts a fresh session:
playwright-cli snapshot
# Result: "Daemon for `default` session started with pid 89690."
# Page URL: about:blank
```

The entire session was destroyed — all cookies, localStorage, browser state, everything gone.

## The correct command
```bash
playwright-cli tab-close [index]  # Closes a specific tab, keeps session alive
```

## Why this matters for agents
If an agent uses `close` thinking it's closing a tab, they lose ALL browser state. Cookies gone. localStorage gone. Any login state gone. Any test setup gone. This is catastrophic mid-test.

## Impact on agent prompt
Critical gotcha: NEVER use `close` unless you intend to destroy the entire session. Use `tab-close <index>` to close individual tabs. If you `close` the last tab, the session dies.

## Workflow implication
For tab-based workflows (open tab, do work, close tab), always use `tab-close`, never `close`.
