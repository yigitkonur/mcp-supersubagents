# 04: Screenshots & Evidence Collection

## Screenshot Types

### Viewport Screenshot (what the user sees)
```bash
playwright-cli screenshot
playwright-cli screenshot --filename=evidence/home-desktop.png
```
Captures only the visible viewport. Default saves to `.playwright-cli/` with auto-generated name.

### Element Screenshot (isolate a component)
```bash
playwright-cli screenshot e20
playwright-cli screenshot e20 --filename=evidence/hero-heading.png
```
Captures just that element, cropped. Useful for documenting specific UI issues.

## Where Screenshots Go

- Without `--filename`: saves to `.playwright-cli/screenshot-{timestamp}.png`
- With `--filename`: saves to `.playwright-cli/{your-path}` (relative to the .playwright-cli dir)

**IMPORTANT:** The `--filename` path is relative to `.playwright-cli/`, not cwd. So:
```bash
playwright-cli screenshot --filename=evidence/page.png
# Saves to: .playwright-cli/evidence/page.png
```

## There Is NO Full-Page Screenshot

Unlike Playwright's `page.screenshot({ fullPage: true })`, the CLI `screenshot` command only captures the viewport. To capture below-the-fold content, you must:

1. Scroll down using `mousewheel`
2. Take another screenshot
3. Repeat

```bash
playwright-cli screenshot --filename=fold-1.png
playwright-cli mousewheel 0 800
playwright-cli screenshot --filename=fold-2.png
playwright-cli mousewheel 0 800
playwright-cli screenshot --filename=fold-3.png
```

Or use `run-code` for a full-page screenshot:
```bash
playwright-cli run-code "async page => { await page.screenshot({ path: 'full-page.png', fullPage: true }); }"
```
But note: `run-code` saves relative to the session's working directory, not `.playwright-cli/`.

## Naming Convention for Evidence

Agent should use a consistent naming pattern:
```
{page}-{viewport}-{description}.png
```
Examples:
```
home-desktop-hero.png
home-mobile-375-navbar.png
seo-desktop-overflow-section.png
contact-tablet-768-form.png
```

## Key Insight for Agent Steering

Tell the agent: "Use `--filename` for every screenshot with descriptive names. The CLI only captures the viewport — scroll with `mousewheel 0 <pixels>` to see below-the-fold content. For full-page captures, use `run-code` with `fullPage: true`."
