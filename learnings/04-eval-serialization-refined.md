# eval serialization: only DOM nodes fail, everything else works

## Initial assumption
My earlier notes said eval "fails on complex returns" and recommended always using `JSON.stringify()`. I assumed most non-primitive returns would break.

## What actually happened (tested systematically)

### Works perfectly — no JSON.stringify needed:
```bash
# Primitives
eval "() => 42"                           # -> 42
eval "() => 'hello'"                      # -> "hello"
eval "() => document.title"               # -> "Zeo: Technical SEO..."
eval "() => document.querySelectorAll('a').length"  # -> 92

# Plain objects
eval "() => ({ links: 92, images: 14 })"  # -> { links: 92, images: 14 }

# Arrays of strings
eval "() => [...document.querySelectorAll('a')].map(a => a.href)"  # -> ["url1", "url2", ...]

# Nested objects with primitives
eval "() => window.performance.timing.loadEventEnd - window.performance.timing.navigationStart"  # -> 639
```

### Fails (returns useless data):
```bash
# DOM nodes — returns "ref: <Node>" for each element
eval "() => document.querySelectorAll('a')"
# -> { "0": "ref: <Node>", "1": "ref: <Node>", ... }
```

## The real rule
`eval` can return anything that's JSON-serializable natively. The ONLY case where you need `JSON.stringify` is when you want to inspect DOM node properties (use `.map()` to extract the data you need as strings/objects first).

## Impact on agent prompt
The gotcha about eval should be narrowed: "DOM elements return as useless `ref: <Node>`. Extract data before returning: use `.map(el => el.href)` instead of returning NodeList directly." Don't scare agents into wrapping everything in JSON.stringify — it's unnecessary for the common case.
