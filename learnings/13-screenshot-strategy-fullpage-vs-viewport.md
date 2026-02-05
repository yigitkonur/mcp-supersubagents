# When to use --full-page vs viewport screenshots vs scroll-and-snap

## Three modes available

### 1. `screenshot --full-page` — Entire scrollable page in one image
```bash
playwright-cli screenshot --full-page
```
- Captures everything from top to bottom
- Great for: visual regression baselines, layout overview, content audit
- Problem: very tall images (hard for LLMs to parse fine details)

### 2. `screenshot` (no flags) — Current viewport only
```bash
playwright-cli screenshot
```
- Captures only what's visible in the current viewport
- Great for: above-the-fold check, specific section after scrolling, element-level detail
- The default and most commonly useful for agents

### 3. `screenshot <ref>` — Single element
```bash
playwright-cli screenshot e426
```
- Captures just that element (saved as `element-*.png` not `page-*.png`)
- Great for: form fields, buttons, specific components, before/after comparisons

## When an agent should use which

### Use `--full-page` for:
- Initial page load assessment ("does this page look right?")
- Visual regression testing (compare with baseline)
- Capturing full page for human review
- Layout audit (checking all sections are present)

### Use viewport screenshot + scroll for:
- Checking what's "above the fold" at different viewport sizes
- Inspecting rendering detail that gets lost in full-page captures
- When the agent needs to see specific content at specific scroll positions
- Progressive page analysis: scroll → screenshot → scroll → screenshot

### Use element screenshot for:
- Form validation error states
- Button hover/active states
- Component-level visual testing
- Comparing before/after for a specific element

## The scroll-and-snap pattern (when you need it)
```bash
# Check above the fold
screenshot --filename=fold-1.png

# Scroll down one viewport
mousewheel 0 720

# Check next fold
screenshot --filename=fold-2.png

# Continue...
mousewheel 0 720
screenshot --filename=fold-3.png
```

## Impact on agent prompt
Teach agents all three modes and when to pick each. Don't default to `--full-page` for everything — viewport screenshots are better for detailed inspection. The scroll-and-snap loop is still useful for fold-by-fold analysis.
