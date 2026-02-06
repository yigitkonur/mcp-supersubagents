# 11: Common Mistakes an Agent WILL Make (and Prevention)

## Mistake 1: Using Stale Element Refs

**What happens:** Agent takes a snapshot on page A, navigates to page B, then tries `click e23` — which was a ref on page A. Click either hits the wrong element or fails.

**Prevention:** "After every `open`, `click` that navigates, `tab-select`, or `reload`, run `snapshot` before interacting with elements."

## Mistake 2: Not Reading Log Files

**What happens:** Agent runs `console error`, sees the output `- [Console](.playwright-cli/console-xxx.log)`, and says "no errors found" because the file path isn't an error.

**Prevention:** "When `console` or `network` returns a file path, you MUST read that file to see the actual content. The path IS the output."

## Mistake 3: Trying to Install Chrome in Non-Interactive Shell

**What happens:** `playwright-cli install` or `npx playwright install chrome` asks for sudo, which doesn't work in agent shells. Agent loops on the same error.

**Prevention:** Use `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright install chromium` (no sudo needed for bundled chromium), then `config --browser=chromium`.

## Mistake 4: Not Stopping Sessions

**What happens:** Agent finishes testing, doesn't stop the session. Daemon processes accumulate. Next test may use a stale session with wrong config.

**Prevention:** "Always run `playwright-cli session-stop-all` at the end of testing."

## Mistake 5: Complex eval Expressions Failing Silently

**What happens:** Agent writes a multi-line eval with optional chaining, arrow functions returning objects, etc. Gets "not well-serializable" or `SyntaxError`.

**Prevention:** "Keep eval expressions simple. Return primitives or wrap in `JSON.stringify()`. Never use optional chaining (?.) in eval — use explicit null checks."

## Mistake 6: Double-Quote Hell in run-code

**What happens:** Agent writes `run-code "async page => { page.locator("h1") }"` — the inner quotes terminate the outer quotes.

**Prevention:** "Use single quotes for run-code wrapper: `run-code 'async page => { ... }'`. Double quotes inside only."

## Mistake 7: Expecting Full-Page Screenshots

**What happens:** Agent takes a screenshot and assumes it captured the entire page. Misses below-the-fold issues.

**Prevention:** "The `screenshot` command only captures the viewport. Scroll with `mousewheel 0 700` between screenshots, or use `run-code` with `fullPage: true`."

## Mistake 8: Forgetting the Config Step

**What happens:** Agent installs chromium but doesn't run `config --browser=chromium`. The `open` command still looks for system Chrome.

**Prevention:** The full setup sequence is: install → session-stop → config → open. All four steps.

## Mistake 9: Using tab-new Incorrectly

**What happens:** Agent runs `tab-new https://example.com/page` but sees snapshot from the previous tab. Or opens tab-new without URL and forgets to navigate.

**Prevention:** "After `tab-new`, always run `snapshot` to confirm you're on the right page. Or use `tab-new` then `open <url>`."

## Mistake 10: Not Checking for Horizontal Overflow

**What happens:** Agent tests responsive by just taking screenshots. Doesn't notice the page has horizontal scroll at 375px because the viewport screenshot doesn't show scroll bars.

**Prevention:** "At every breakpoint, run the overflow detection eval: `() => ({ hasHScroll: document.body.scrollWidth > window.innerWidth, scrollW: document.body.scrollWidth, viewportW: window.innerWidth })`"

## Key Insight for Agent Steering

These 10 mistakes should be preempted in the prompt. The prompt should include the correct patterns so the agent never hits these failure modes in the first place.
