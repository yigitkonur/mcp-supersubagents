# 13: CSS Debug Recipes — Copy-Paste Eval Patterns

## Layout Debugging

### Check element dimensions & position
```bash
playwright-cli eval "() => { const el = document.querySelector('.hero'); const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; }"
```

### Check if element is in viewport
```bash
playwright-cli eval "() => { const r = document.querySelector('.cta-button').getBoundingClientRect(); return { inView: r.top < window.innerHeight && r.bottom > 0, top: r.top, bottom: r.bottom, viewportH: window.innerHeight }; }"
```

### Find ALL overflowing elements (horizontal scroll bug)
```bash
playwright-cli eval "() => [...document.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth && el.clientWidth > 0).map(el => ({ tag: el.tagName, class: el.className.substring(0,50), scrollW: el.scrollWidth, clientW: el.clientWidth })).slice(0, 10)"
```

### Check flex/grid layout
```bash
playwright-cli eval "() => { const s = getComputedStyle(document.querySelector('.container')); return { display: s.display, flexDir: s.flexDirection, gap: s.gap, justifyContent: s.justifyContent, alignItems: s.alignItems }; }"
```

## Typography

### Font rendering check
```bash
playwright-cli eval "() => { const s = getComputedStyle(document.querySelector('h1')); return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, color: s.color }; }"
```

## Visibility

### Hidden element investigation
```bash
playwright-cli eval "() => { const el = document.querySelector('.missing-element'); if (!el) return 'NOT IN DOM'; const s = getComputedStyle(el); return { display: s.display, visibility: s.visibility, opacity: s.opacity, height: el.offsetHeight, width: el.offsetWidth, overflow: s.overflow }; }"
```

### Z-index stack audit
```bash
playwright-cli eval "() => [...document.querySelectorAll('*')].map(el => ({ tag: el.tagName, class: el.className.substring(0,30), z: getComputedStyle(el).zIndex })).filter(i => i.z !== 'auto').sort((a,b) => Number(b.z) - Number(a.z)).slice(0, 10)"
```

## State Inspection

### Check all localStorage
```bash
playwright-cli eval "() => JSON.stringify(localStorage)"
```

### Check cookies
```bash
playwright-cli eval "() => document.cookie"
```
Or use the dedicated commands:
```bash
playwright-cli cookie-list
playwright-cli localstorage-list
```

## Performance

### Core Web Vitals (approximate)
```bash
playwright-cli eval "() => { const nav = performance.getEntriesByType('navigation')[0]; const paint = performance.getEntriesByType('paint'); return { ttfb: Math.round(nav.responseStart - nav.requestStart), domLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime), loadComplete: Math.round(nav.loadEventEnd - nav.startTime), fcp: paint.find(p => p.name === 'first-contentful-paint')?.startTime }; }"
```

### Resource count and sizes
```bash
playwright-cli eval "() => { const res = performance.getEntriesByType('resource'); const byType = {}; res.forEach(r => { const ext = r.name.split('.').pop().split('?')[0]; byType[ext] = (byType[ext] || 0) + 1; }); return { total: res.length, byType }; }"
```

## Key Insight for Agent Steering

These recipes should be embedded in the prompt as reference patterns. The agent should NOT have to figure out the eval syntax from scratch — give it these exact patterns to copy-paste.
