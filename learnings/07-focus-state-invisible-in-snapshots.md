# Tab/keyboard focus is NOT visible in snapshot YAML

## Initial assumption
I assumed that pressing Tab would show a `[focused]` attribute on the focused element in the snapshot, similar to how `[active]` and `[expanded]` appear.

## What actually happened
```bash
playwright-cli press Tab
playwright-cli snapshot
# The root element lost [active], but NO element gained [focused]
```

The focused element was confirmed via eval:
```bash
playwright-cli eval "() => document.activeElement?.tagName + ' ' + document.activeElement?.textContent?.substring(0, 30)"
# -> "A We are here for you"
```

So focus was on a link, but the snapshot showed no indication of this.

## Why this matters for agents
Accessibility testing requires checking focus order, focus visibility, and keyboard navigation. If the agent relies solely on snapshots to determine focus, they'll never see it.

## The workaround
Use eval to check focus:
```bash
# What element has focus?
eval "() => document.activeElement?.tagName"

# Full focus details:
eval "() => { const el = document.activeElement; return { tag: el?.tagName, text: el?.textContent?.substring(0,50), id: el?.id, className: el?.className }; }"
```

## Impact on agent prompt
For accessibility testing guidance: mention that focus state must be checked via `eval "() => document.activeElement"`, not from snapshots. Snapshots show structure and some states ([expanded], [disabled], [checked]) but NOT keyboard focus.
