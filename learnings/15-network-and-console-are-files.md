# console and network output are FILE PATHS, not inline content

## Initial assumption
I initially expected `console` and `network` to print log entries directly to stdout.

## What actually happens
```bash
playwright-cli console
# Result:
# - [Console](.playwright-cli/console-2026-02-05T11-37-01-982Z.log)

playwright-cli network
# Result:
# - [Network](.playwright-cli/network-2026-02-05T11-52-03-645Z.log)
```

The CLI returns a **file path**. The agent must read that file to see the actual content.

## Useful flags

### console
```bash
console                  # All console messages
console error            # Only errors and above (min-level filter)
console --clear          # Clear the log (runs silently, no output)
```

### network
```bash
network                  # Dynamic requests only (API calls, XHR, fetch)
network --static         # ALL resources (fonts, CSS, JS, images too)
network --clear          # Clear the log (runs silently, no output)
```

## The --clear pattern for test phases
```bash
# Phase 1: Test page load
open https://example.com
console                  # Get page load console entries
network                  # Get page load network requests

# Clear before next phase
console --clear
network --clear

# Phase 2: Test form submission
fill e53 "test"
click e64                # Submit button
console                  # Only entries from form submission
network                  # Only requests from form submission
```

## Impact on agent prompt
Agents need to know the two-step: run `console`/`network` to get the file path, then read the file. Also, `--clear` is essential for isolating logs between test phases.
