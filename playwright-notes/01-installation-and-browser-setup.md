# 01: Installation & Browser Setup

## The Problem

`playwright-cli open <url>` fails immediately with:
```
Error: browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Run "npx playwright install chrome"
```

This happens because playwright-cli defaults to the `chrome` channel (system Chrome), NOT the bundled Playwright chromium.

## What Does NOT Work

1. `playwright-cli install-browser` — command does not exist (despite being in the SKILL.md docs)
2. `playwright-cli install` — tries to install Chrome but fails with `sudo: a terminal is required` in non-interactive shells
3. `npx playwright install chrome` — same sudo failure
4. `playwright-cli open --browser=chromium <url>` — the `--browser` flag on `open` does NOT override the default; it still looks for system Chrome

## What DOES Work

### Step 1: Install the bundled Chromium (no sudo needed)
```bash
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright install chromium
```
This downloads Chromium to `~/.cache/ms-playwright/chromium-XXXX/` without needing system dependencies.

### Step 2: Configure the session to use bundled chromium
```bash
playwright-cli session-stop 2>/dev/null
playwright-cli config --browser=chromium
```
The `config` command sets the browser for the session. This must be done BEFORE `open`.

### Step 3: Then open works
```bash
playwright-cli open https://example.com
```

## Self-Healing Install Prompt (for agent)

Agent should detect the install failure and run this sequence:
```bash
# Check if playwright-cli exists
which playwright-cli || npm install -g @playwright/cli@latest

# Install browser (no sudo needed)
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright install chromium

# Configure session to use it
playwright-cli session-stop 2>/dev/null
playwright-cli config --browser=chromium
```

## Key Insight for Agent Steering

The agent MUST be told: "If `open` fails with a browser-not-found error, install chromium via `npx playwright install chromium` and configure the session with `playwright-cli config --browser=chromium` before retrying." Otherwise it will loop on the same error.
