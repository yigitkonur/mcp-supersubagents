# 03: Snapshots and Element Refs — The Core Navigation Model

## How Playwright-CLI Identifies Elements

Unlike Selenium/CSS selectors, playwright-cli uses a **snapshot-based ref system**. Every element gets a ref like `e1`, `e2`, `e23`.

### Taking a Snapshot
```bash
playwright-cli snapshot
```

Returns a YAML-like tree:
```
- banner [ref=e3]:
  - link "Homepage" [ref=e7]:
  - button "Menu" [ref=e9]:
- main [ref=e12]:
  - heading "Tailor-made strategies..." [level=1] [ref=e20]
  - link "Create your AI roadmap" [ref=e23]:
```

### Using Refs
```bash
playwright-cli click e23        # click the "Create your AI roadmap" link
playwright-cli screenshot e20   # screenshot just the h1 element
playwright-cli fill e5 "text"   # fill an input field
```

## Snapshots Are Saved to Files

Every snapshot writes a `.yml` file:
```
.playwright-cli/page-2026-02-05T11-37-07-185Z.yml
```

The agent can re-read this file if it needs to reference elements later.

## Refs Change After Navigation

**CRITICAL:** After navigating to a new page (or even after a client-side route change), ALL refs are invalidated. The agent MUST take a new snapshot after:
- `open <url>` (navigating)
- Clicking a link that navigates
- `tab-select` (switching tabs)
- `reload`
- `go-back` / `go-forward`

Pattern:
```bash
playwright-cli open https://example.com/page
playwright-cli snapshot          # get fresh refs
playwright-cli click e5          # use refs from THIS snapshot
```

## Snapshot Output Is Also Auto-Generated on `open`

When you run `playwright-cli open <url>`, it automatically returns a snapshot. You don't need an explicit `snapshot` call after `open`. But after clicks that change page content, you DO need a fresh snapshot.

## Element Screenshots Use Semantic Locators

When you `screenshot e20`, playwright-cli generates the Playwright locator automatically:
```js
await page.getByRole('heading', { name: 'Tailor-made strategies to' }).screenshot({...});
```

This means element refs resolve to accessibility-based locators, which is resilient.

## Key Insight for Agent Steering

Tell the agent: "After every navigation or major page change, run `snapshot` to get fresh element refs. Never reuse refs from a previous page. The snapshot YAML file is your map of the page."
