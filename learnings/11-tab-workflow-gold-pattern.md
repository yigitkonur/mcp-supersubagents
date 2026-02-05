# Tab-based workflow: THE pattern for parallel testing

## The insight
Instead of creating new browser sessions for each test scenario, use tabs within a single session. This preserves cookies, localStorage, and browser state while isolating visual contexts.

## Why tabs are gold
1. **Memory efficient** — One browser instance, multiple contexts
2. **Shared state** — Cookies, localStorage persist across tabs (like real users)
3. **Easy cleanup** — `tab-close` cleans up; when all tabs are closed, task is done
4. **Parallel viewports** — Tab 0 = desktop, Tab 1 = mobile, Tab 2 = dark mode desktop

## The workflow pattern
```bash
# SETUP: Open base page
open https://example.com

# TAB 1: Desktop (default 1280x720)
screenshot --full-page --filename=desktop.png

# TAB 2: Mobile
tab-new
open https://example.com      # MUST open after tab-new (it starts at about:blank)
resize 375 812
screenshot --full-page --filename=mobile.png

# TAB 3: Desktop dark mode
tab-new
open https://example.com
eval "() => document.documentElement.classList.add('dark')"  # or inject media query
screenshot --full-page --filename=desktop-dark.png

# TAB 4: Mobile dark mode
tab-new
open https://example.com
resize 375 812
eval "() => document.documentElement.classList.add('dark')"
screenshot --full-page --filename=mobile-dark.png

# CLEANUP: Close all tabs when done
tab-close 3
tab-close 2
tab-close 1
# Tab 0 remains — when agent closes it, task is complete
```

## Critical reminder
`tab-new <url>` does NOT navigate! Always follow with `open <url>`.

## Task completion signal
Agents can use tab count as a progress indicator:
- All test tabs open = all scenarios in progress
- Tab closed = scenario complete
- All tabs closed = testing complete

## Impact on agent prompt
This workflow pattern should be taught as the PRIMARY way to handle multi-viewport / multi-mode testing. It's memory-efficient, state-preserving, and gives agents a clear "done" signal.

## For parallel agents (10 agents scenario)
If 10 agents share one browser via sessions, each agent should work in its own tabs within the session. This avoids 10 separate browser instances eating memory. The tab isolation pattern becomes essential at scale.
