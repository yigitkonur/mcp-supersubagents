# 06: Console Messages & Network Request Debugging

## Console Messages

### Get all messages
```bash
playwright-cli console
```
Returns a path to a log file. NOT stdout — you must read the file.

### Filter by severity
```bash
playwright-cli console error      # only errors
playwright-cli console warning    # warnings and above
```

### What the log looks like
```
SyntaxError: Failed to execute 'appendChild' on 'Node'...
[ERROR] Creating a worker from '.../sw.js' violates CSP...
[ERROR] Failed to load resource: 500 () @ https://example.com/api/foo
[WARNING] Resource was preloaded but not used...
```

Format: lines prefixed with `[ERROR]` or `[WARNING]` for those levels. Plain text for uncaught exceptions.

### Accumulated Since Page Load
Console messages accumulate across the entire session. Each `console` call returns ALL messages since the page was loaded. New entries are indicated:
```
- 8 new console entries in ".playwright-cli/console-...log#L14-L23"
```

## Network Requests

```bash
playwright-cli network
```
Returns a log file with ALL requests since page load:
```
[GET] https://example.com/api/users => [200]
[POST] https://example.com/api/login => [401]
[GET] https://example.com/tools/foo => [500]
```

### What you can spot
- **500 errors** — server-side failures (found 6 on the test site)
- **404 errors** — broken links or missing resources
- **Preflight failures** — CORS issues
- **Slow requests** — though timing isn't shown, you can identify patterns

### Limitation: No Request/Response Bodies
The `network` command only shows method, URL, and status. For headers or bodies, use tracing or `run-code`.

## Tracing for Deep Debugging

```bash
playwright-cli tracing-start
# ... perform actions ...
playwright-cli tracing-stop
```

Creates files in `.playwright-cli/traces/`:
- `trace-{timestamp}.trace` — action log with DOM snapshots
- `trace-{timestamp}.network` — full network with headers/bodies
- `resources/` — cached assets

Tracing adds overhead. Only use when investigating a specific issue.

## Pattern: Quick Health Check

Agent should run this immediately after opening any page:
```bash
playwright-cli open https://example.com
playwright-cli console error     # any JS errors?
playwright-cli network           # any 4xx/5xx requests?
playwright-cli screenshot --filename=initial-state.png
```

This gives a baseline: is the page even healthy?

## Key Insight for Agent Steering

Tell the agent: "Always check `console error` and `network` after loading a page. Console and network output goes to log files, not stdout — read the file path from the output. Look for 500s in network and JS errors in console as the first diagnostic step."
