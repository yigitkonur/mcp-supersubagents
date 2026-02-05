# network --static shows ALL resources; default shows only dynamic requests

## What happened
```bash
# Default:
playwright-cli network
# Shows: API calls, XHR, fetch requests only

# With --static:
playwright-cli network --static
# Shows: EVERYTHING — fonts, CSS, JS, images, API calls (186 entries vs ~20)
```

## When to use which

### Default (no flag) — for functional testing
- API response codes
- Failed requests
- XHR/fetch timing
- Checking if the right APIs are called

### --static — for performance/SEO auditing
- Total resource count and sizes
- Font loading (are all fonts loading?)
- CSS/JS bundle analysis
- Image optimization audit
- Checking for unnecessary requests

## Pattern: isolate network by test phase
```bash
network --clear           # Reset
# ... perform action ...
network                   # See only requests from that action
```

## Impact on agent prompt
Mention `--static` for when agents need a full resource audit. Default is fine for most functional testing.
