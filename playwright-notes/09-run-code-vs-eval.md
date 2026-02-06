# 09: run-code vs eval — When to Use Which

## eval

**Syntax:** `playwright-cli eval "<js expression>" [ref]`

**Runs in:** The page context (like browser DevTools console)

**Good for:**
- Reading DOM properties
- getComputedStyle checks
- Performance API queries
- Simple document queries
- Checking visibility, dimensions, state

**Limitations:**
- Cannot interact with the page (no clicks, fills, waits)
- Cannot access Playwright's page API
- Complex return values may fail with "not well-serializable"
- No async/await for multi-step operations

**Examples:**
```bash
playwright-cli eval "() => document.title"
playwright-cli eval "() => getComputedStyle(document.querySelector('h1')).fontSize"
playwright-cli eval "() => window.innerWidth"
```

## run-code

**Syntax:** `playwright-cli run-code "<playwright code>"`

**Runs in:** Node.js with access to `page` object (Playwright API)

**Good for:**
- Multi-step workflows (navigate, wait, interact, extract)
- Waiting for elements/conditions
- Working with iframes
- File downloads
- Setting geolocation, permissions
- Full-page screenshots
- Complex async operations

**Limitations:**
- Quote escaping is a nightmare (shell eats quotes)
- Harder to debug errors
- Overkill for simple reads

**Examples:**
```bash
playwright-cli run-code 'async page => { return await page.title(); }'
playwright-cli run-code 'async page => { await page.screenshot({ path: "full.png", fullPage: true }); }'
playwright-cli run-code 'async page => { await page.waitForSelector(".loading", { state: "hidden" }); }'
```

## The Quote Escaping Problem

This is the #1 source of errors with `run-code`. The shell, the CLI, and JavaScript all interpret quotes.

### Rules:
1. Use SINGLE quotes for the outer wrapper
2. Use DOUBLE quotes inside the JS code
3. Avoid backticks entirely (template literals break)
4. If you need single quotes inside, escape with `'\''`

```bash
# WORKS
playwright-cli run-code 'async page => { return await page.locator("h1").textContent(); }'

# FAILS (double-double quote collision)
playwright-cli run-code "async page => { return await page.locator("h1").textContent(); }"

# FAILS (backtick template literal)
playwright-cli run-code 'async page => { return `Title: ${await page.title()}`; }'
```

## Decision Guide

| Need to... | Use |
|------------|-----|
| Read a CSS property | `eval` |
| Check if element exists | `eval` |
| Get page dimensions | `eval` |
| Read localStorage/cookies | `eval` |
| Find overflowing elements | `eval` |
| Wait for element to appear | `run-code` |
| Take full-page screenshot | `run-code` |
| Multi-step form interaction | CLI commands (`fill`, `click`) |
| Set geolocation | `run-code` |

## Key Insight for Agent Steering

Tell the agent: "Default to `eval` for all inspection/reading. Use `run-code` only for things that need Playwright API (waits, full-page screenshots, permissions). Use single quotes outside, double inside for `run-code`. If it fails, simplify the expression."
