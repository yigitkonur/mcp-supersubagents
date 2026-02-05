# Bootstrap sequence: the steps that prevent agent failure before testing even starts

## What we discovered

### PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true is essential
Without this env var, Playwright's install command may fail on certain systems (containers, non-standard Linux) by checking for system dependencies that aren't actually needed for headless Chromium.

### Session cleanup before start
If a previous agent crashed or didn't clean up, a stale session blocks everything:
```bash
playwright-cli session-stop 2>/dev/null   # Kill stale session, ignore error if none
```

### Browser install
```bash
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright install chromium
```

### Config
```bash
playwright-cli config --browser=chromium
```

## The complete bootstrap sequence
```bash
which playwright-cli || npm install -g @anthropic-ai/playwright-cli@latest
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright install chromium
playwright-cli session-stop 2>/dev/null
playwright-cli config --browser=chromium
```

## Why each step matters
1. `which` check — avoid reinstalling if already present
2. `PLAYWRIGHT_SKIP_*` — prevent false install failures
3. `session-stop` — prevent "session already running" blocks
4. `config` — ensure chromium is the active browser

## Impact on agent prompt
This bootstrap sequence should be at the top of the testing workflow, before any test commands. It's a safety net that handles the most common "can't even start" failures.
