# Playwright auto-scrolls to off-screen elements on click/hover/fill

## Initial assumption
I worried that clicking elements far down the page (like footer links) might fail because they're not in the viewport.

## What actually happened
```bash
# e455 is a footer link, way below the fold on a long homepage
playwright-cli click e455
# Result: Successfully clicked! Playwright scrolled to the element automatically.
```

## Why this matters
Agents do NOT need to manually scroll to an element before interacting with it. Playwright's `click()`, `fill()`, `hover()`, etc. all auto-scroll to the target element first.

## When you DO need manual scrolling
- Checking what's visible "above the fold" at different scroll positions
- Testing lazy-loaded content that only renders when scrolled into view
- Taking viewport screenshots at specific scroll positions
- Testing infinite scroll behavior

## How to scroll manually when needed
```bash
mousewheel 0 500          # Scroll down 500px
mousewheel 0 -500         # Scroll up 500px
eval "() => document.querySelector('#target').scrollIntoView()"  # Scroll to specific element
```

## Impact on agent prompt
Don't include scroll instructions for basic element interaction. Agents should know that click/fill/hover handle scrolling. Only teach manual scrolling for viewport-specific testing scenarios.
