# 14: Interaction Patterns — Clicks, Forms, Navigation

## Clicking Elements

```bash
playwright-cli snapshot          # get refs first
playwright-cli click e23         # click by ref
```

After clicking a link that navigates, the page changes. Take a new snapshot:
```bash
playwright-cli click e23         # navigates to /new-page
playwright-cli snapshot          # fresh refs for new page
playwright-cli screenshot --filename=after-click.png
```

## Form Filling

```bash
playwright-cli snapshot          # find input refs
playwright-cli fill e5 "user@example.com"
playwright-cli fill e6 "password123"
playwright-cli click e7          # submit button
```

`fill` clears the field first, then types. For appending, use `type` instead.

## Type vs Fill

- `fill e5 "text"` — clears field, sets value (like pasting)
- `type "text"` — types character by character into the currently focused element

`type` does NOT take a ref — it types into whatever is focused. So:
```bash
playwright-cli click e5          # focus the input
playwright-cli type "search query"
playwright-cli press Enter
```

## Keyboard Events

```bash
playwright-cli press Enter
playwright-cli press Tab
playwright-cli press Escape
playwright-cli press ArrowDown
playwright-cli press ArrowDown
playwright-cli press Enter       # select dropdown option
```

## Hover (for dropdowns/tooltips)

```bash
playwright-cli hover e9          # hover over menu trigger
playwright-cli snapshot          # dropdown should now be visible
playwright-cli click e15         # click dropdown option
```

## Dialog Handling

If a click triggers a confirm/alert dialog:
```bash
playwright-cli click e10         # triggers dialog
playwright-cli dialog-accept     # click OK
# or
playwright-cli dialog-dismiss    # click Cancel
```

## Select Dropdowns

```bash
playwright-cli select e9 "option-value"    # by value attribute
```

## Checkbox/Radio

```bash
playwright-cli check e12         # check
playwright-cli uncheck e12       # uncheck
```

## The "Wait After Action" Problem

playwright-cli does NOT auto-wait for navigation or animations after clicks. If clicking triggers a client-side route change or AJAX:

```bash
playwright-cli click e23         # triggers async navigation
# Immediately taking snapshot may show transition state
playwright-cli run-code 'async page => { await page.waitForLoadState("networkidle"); }'
playwright-cli snapshot          # now the page has settled
```

Or simpler — just add a small delay:
```bash
playwright-cli click e23
playwright-cli eval "() => new Promise(r => setTimeout(r, 1000))"
playwright-cli snapshot
```

## Key Insight for Agent Steering

Tell the agent: "Always `snapshot` before interacting to get refs. After clicks that navigate, wait for the page to settle (use `eval` with setTimeout or `run-code` with waitForLoadState) before taking a new snapshot. Use `fill` for form inputs, `click` for buttons/links."
