# 05: eval & CSS Inspection — Gotchas and Working Patterns

## eval Basics

```bash
playwright-cli eval "<js expression>"
playwright-cli eval "<js expression>" <ref>   # eval on specific element
```

## What Works

### Simple return values (strings, numbers, plain objects)
```bash
playwright-cli eval "() => document.title"
# Returns: "Zeo: Technical SEO & Digital Marketing Agency in London"
```

### getComputedStyle — the money pattern for CSS debugging
```bash
playwright-cli eval "() => { const h1 = document.querySelector('h1'); const s = getComputedStyle(h1); return { fontSize: s.fontSize, fontFamily: s.fontFamily, color: s.color, lineHeight: s.lineHeight }; }"
```
Returns:
```json
{ "fontSize": "50px", "fontFamily": "gilroy, sans-serif", "color": "rgb(39, 48, 65)", "lineHeight": "65px" }
```

### JSON.stringify wrapper for arrays of objects
```bash
playwright-cli eval '() => JSON.stringify(Array.from(document.querySelectorAll("a")).slice(0,10).map(a => a.href))'
```

### Performance metrics
```bash
playwright-cli eval "() => { const nav = performance.getEntriesByType('navigation')[0]; return { loadTime: nav.loadEventEnd - nav.startTime, domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime, ttfb: nav.responseStart - nav.requestStart }; }"
```

### Finding overflowing elements (horizontal scroll bugs)
```bash
playwright-cli eval "() => [...document.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth).map(el => ({ tag: el.tagName, class: el.className.substring(0,50), scrollW: el.scrollWidth, clientW: el.clientWidth })).slice(0, 10)"
```

## What Does NOT Work

### Complex objects with optional chaining or ?.
```bash
# FAILS — "not well-serializable"
playwright-cli eval '() => Array.from(document.querySelectorAll("a")).map(a => ({href: a.getAttribute("href"), text: a.textContent.trim()}))'
```
The `Passed function is not well-serializable!` error occurs when the function body is too complex for eval's serializer.

**Fix:** Wrap the entire result in `JSON.stringify()`:
```bash
playwright-cli eval '() => JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({href: a.href, text: a.textContent})))'
```

### run-code with double quotes inside double quotes
```bash
# FAILS — shell quote hell
playwright-cli run-code "async page => { await page.locator("a").count(); }"
```
The inner quotes break the outer quotes.

**Fix:** Use single quotes for the outer wrapper, double quotes inside:
```bash
playwright-cli run-code 'async page => { return await page.locator("a").count(); }'
```
But even this can fail with complex code. For anything beyond simple expressions, eval is more reliable.

## Quote Handling Rules

| Pattern | Use |
|---------|-----|
| `eval "() => simple expr"` | Double quotes, no inner quotes needed |
| `eval '() => expr with "quotes"'` | Single outer, double inner |
| `eval "() => { const s = getComputedStyle(...); return { prop: s.prop }; }"` | Works because inner uses single-char props |

## Key Insight for Agent Steering

Tell the agent: "Use `eval` for all CSS/DOM inspection. Keep expressions simple. If you get 'not well-serializable', wrap in `JSON.stringify()`. For getComputedStyle, always return a plain object with the specific properties you need — never return the full CSSStyleDeclaration."
