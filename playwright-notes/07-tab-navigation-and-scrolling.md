# 07: Tab Navigation & Scrolling

## Tabs: Use For Multi-Page Comparison

### Open a new tab with a URL
```bash
playwright-cli tab-new https://example.com/page-b
```

**GOTCHA:** `tab-new` opens the tab but the `open` that follows may show the PREVIOUS tab's snapshot. After `tab-new`, you're automatically on the new tab, but you need to navigate explicitly:
```bash
playwright-cli tab-new https://example.com/page-b
playwright-cli snapshot    # now you get page-b's content
```

Or just use `tab-new` without a URL and then `open`:
```bash
playwright-cli tab-new
playwright-cli open https://example.com/page-b
```

### List tabs
```bash
playwright-cli tab-list
```
Returns:
```
- 0: [Home Page Title](https://example.com/)
- 1: (current) [SEO Page](https://example.com/seo)
```
The `(current)` marker shows which tab is active.

### Switch tabs
```bash
playwright-cli tab-select 0    # switch to first tab
playwright-cli tab-select 1    # switch to second tab
```

**AFTER switching tabs, always take a fresh snapshot.** Refs from the previous tab are invalid.

### Close a tab
```bash
playwright-cli tab-close 1     # close tab by index
playwright-cli tab-close       # close current tab
```

## Scrolling: mousewheel Is Your Only Option

The CLI has NO `scrollTo` or `scrollDown` command. Use `mousewheel`:

```bash
playwright-cli mousewheel 0 500     # scroll down 500px
playwright-cli mousewheel 0 -500    # scroll up 500px
playwright-cli mousewheel 500 0     # scroll right 500px
```

### Scroll-and-screenshot pattern for full-page review
```bash
playwright-cli screenshot --filename=fold-1.png
playwright-cli mousewheel 0 700
playwright-cli screenshot --filename=fold-2.png
playwright-cli mousewheel 0 700
playwright-cli screenshot --filename=fold-3.png
playwright-cli mousewheel 0 700
playwright-cli screenshot --filename=fold-4.png
```

### Scroll to bottom
```bash
playwright-cli eval "() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; }"
```
This is more reliable than mousewheel for "go to bottom" because you don't need to guess the page height.

### Scroll to specific element
```bash
playwright-cli eval "() => { document.querySelector('footer').scrollIntoView(); }"
playwright-cli snapshot    # now footer elements have refs
```

## The "Navigate vs Open" Confusion

- `playwright-cli open <url>` — navigates the CURRENT tab to that URL
- `playwright-cli tab-new <url>` — opens a NEW tab with that URL
- Clicking a link (e.g., `click e23`) — navigates in the CURRENT tab (like a real user)

If you want to keep the current page visible while checking another:
```bash
playwright-cli tab-new https://example.com/other-page
# ... inspect other page ...
playwright-cli tab-select 0    # go back to original
```

## Key Insight for Agent Steering

Tell the agent: "Use `open` for same-tab navigation, `tab-new` for parallel comparisons. Scroll with `mousewheel 0 <pixels>` or `eval` with `scrollIntoView()`. After every tab switch or navigation, take a fresh `snapshot`. Never use stale element refs."
