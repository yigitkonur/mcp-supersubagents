# Multi-tab snapshot shows WRONG tab's URL in "Page" section

## Initial assumption
I assumed the "Page URL" and "Page Title" in the snapshot output always reflect the currently active tab.

## What actually happened
When on tab 1 (/hello), the snapshot output showed:
```
### Page
- Page URL: https://zeo-nextjs-theta.vercel.app/seo   <-- WRONG! This is tab 0
- Page Title: What is SEO?...                           <-- WRONG! This is tab 0
```

But:
- The "Open tabs" section correctly showed tab 1 as `(current)`
- `eval "() => window.location.href"` correctly returned the tab 1 URL
- The snapshot element tree was from the correct tab (tab 1)

## The bug pattern
Only the "Page" metadata header is wrong. Everything else (element tree, eval, Open tabs listing) works correctly on the right tab.

## Why this matters for agents
An agent checking "Page URL" to verify navigation succeeded would get confused. They'd think they're on the wrong page even though they're actually on the right one.

## Impact on agent prompt
When using multiple tabs, tell agents: trust the "Open tabs" section (which shows `(current)`) and verify with `eval "() => window.location.href"` if unsure. Don't rely on the "Page URL" header when multiple tabs are open.
