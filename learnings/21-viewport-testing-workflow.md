# Multi-viewport testing workflow: desktop, mobile, tablet

## Standard breakpoints
| Device | Width | Height | Name |
|--------|-------|--------|------|
| Desktop | 1280 | 720 | desktop |
| Tablet | 768 | 1024 | tablet |
| Mobile | 375 | 812 | mobile |

## Single-tab approach (simple)
```bash
# Start at desktop (default)
open https://example.com
screenshot --full-page --filename=desktop.png

# Resize to mobile
resize 375 812
screenshot --full-page --filename=mobile.png

# Resize to tablet
resize 768 1024
screenshot --full-page --filename=tablet.png

# Back to desktop
resize 1280 720
```

## Multi-tab approach (parallel, preserves each viewport)
```bash
# Tab 0: Desktop (already open)
open https://example.com
screenshot --full-page --filename=desktop.png

# Tab 1: Mobile
tab-new
open https://example.com
resize 375 812
screenshot --full-page --filename=mobile.png

# Tab 2: Tablet
tab-new
open https://example.com
resize 768 1024
screenshot --full-page --filename=tablet.png

# Can switch between tabs to compare
tab-select 0   # Desktop
tab-select 1   # Mobile
tab-select 2   # Tablet
```

## Why multi-tab is better
1. Each viewport is preserved — you can switch back to inspect details
2. You can compare specific elements across viewports
3. Resize doesn't re-trigger page load (single-tab does trigger re-layout)
4. Each tab maintains its own scroll position

## Responsive breakpoint testing
```bash
# Automated breakpoint sweep
run-code 'async (page) => {
  const breakpoints = [320, 375, 425, 768, 1024, 1280, 1440, 1920];
  for (const w of breakpoints) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.screenshot({
      fullPage: true,
      path: `.playwright-cli/responsive-${w}.png`
    });
  }
  return "Done: " + breakpoints.length + " screenshots";
}'
```

## Impact on agent prompt
Give agents the standard breakpoints and both approaches. Multi-tab is preferred for thorough testing. The automated sweep via `run-code` is available for comprehensive responsive audits.

## Key: don't be rigid about breakpoints
The agent should also check the site's own CSS breakpoints if possible:
```bash
eval "() => { const sheets = [...document.styleSheets]; /* scan for @media queries */ }"
```
Or just test the standard ones and let the agent add more if layout issues are found.
