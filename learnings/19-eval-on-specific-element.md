# eval with ref: run JavaScript on a specific element

## Discovery
`eval` accepts an optional ref parameter that runs the function ON that element:

```bash
# Without ref — runs on page (window context)
eval "() => document.title"

# With ref — function receives the element as argument
eval "(el) => el.value" e53
eval "(el) => getComputedStyle(el).fontSize" e156
eval "(el) => el.getBoundingClientRect()" e9
```

## What the CLI generates
```bash
eval "(el) => el.value" e53
# Ran Playwright code:
# await page.getByRole('textbox', { name: 'First Name' }).evaluate('(el) => el.value');
```

It uses `.evaluate()` on the locator, so `el` is the actual DOM element.

## Powerful patterns

### Get computed styles
```bash
eval "(el) => { const s = getComputedStyle(el); return { fontSize: s.fontSize, color: s.color, display: s.display }; }" e156
```

### Check element dimensions
```bash
eval "(el) => el.getBoundingClientRect()" e9
# Returns: { x, y, width, height, top, right, bottom, left }
```

### Get input value
```bash
eval "(el) => el.value" e53
```

### Check element visibility
```bash
eval "(el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }" e9
```

## Impact on agent prompt
This is a powerful tool that agents should know about. It's especially useful for:
- Checking form field values
- Inspecting CSS styles (accessibility: font sizes, contrast)
- Verifying element dimensions
- Checking element attributes that don't appear in snapshots
