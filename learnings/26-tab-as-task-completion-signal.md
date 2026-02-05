# Using tabs as task completion signals

## The concept
Agents love following workflows with clear completion signals. Tabs provide a natural one:
- Open tab = start a test scenario
- Work in tab = execute the test
- Close tab = scenario complete
- All tabs closed = ALL testing complete

## Proposed workflow

### Task setup
```bash
# Initial page (tab 0) — always keep this as "home base"
open https://example.com

# Open a tab for each test scenario
tab-new           # Tab 1: Desktop light
open https://example.com
tab-new           # Tab 2: Mobile light
open https://example.com
resize 375 812
tab-new           # Tab 3: Desktop dark
open https://example.com
run-code 'async (page) => { await page.emulateMedia({ colorScheme: "dark" }); }'
```

### Task execution
```bash
# Work on tab 1
tab-select 1
# ... desktop tests ...
screenshot --filename=desktop-result.png
tab-close 1       # Done with desktop

# Work on tab 2 (now index shifted!)
tab-select 1      # Was tab 2, now tab 1 after closing
# ... mobile tests ...
screenshot --filename=mobile-result.png
tab-close 1       # Done with mobile
```

### Gotcha: Index shifting after tab-close
When you close tab 1, the former tab 2 becomes tab 1. Agents must be aware of this index shifting. Using `tab-list` after close helps confirm the new order.

### Completion check
```bash
tab-list
# If only tab 0 remains (or no tabs), testing is complete
```

## Why this works for agents
1. Clear progress tracking — tab count = remaining work
2. Natural cleanup — closed tabs free resources
3. Observable state — `tab-list` shows what's left
4. Prevents forgetting — open tabs remind the agent what's unfinished

## Impact on agent prompt
Teach this as an optional workflow pattern. Not all tests need it, but complex multi-scenario tests benefit from the structure. The index shifting after close is critical to mention.
