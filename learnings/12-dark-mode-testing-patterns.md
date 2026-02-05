# Dark mode testing: multiple approaches, give agents flexibility

## The problem
Dark mode is now a standard feature. Agents testing UI need to capture dark mode screenshots alongside light mode. But there's no single "enable dark mode" button — every site implements it differently.

## Approaches (from most reliable to most fragile)

### 1. System preference emulation via run-code (MOST RELIABLE)
```bash
run-code 'async (page) => {
  await page.emulateMedia({ colorScheme: "dark" });
}'
```
This tells Playwright to emulate the system `prefers-color-scheme: dark` media query. Works for any site that uses `@media (prefers-color-scheme: dark)`.

### 2. CSS class injection (COMMON)
Many frameworks (Tailwind, Next.js themes) use a class on `<html>` or `<body>`:
```bash
eval "() => document.documentElement.classList.add('dark')"
# or
eval "() => document.documentElement.setAttribute('data-theme', 'dark')"
```

### 3. localStorage/cookie toggle (SITE-SPECIFIC)
Some sites store theme preference:
```bash
eval "() => { localStorage.setItem('theme', 'dark'); location.reload(); }"
```

### 4. Click the theme toggle (MOST REALISTIC but fragile)
```bash
# Find the toggle in snapshot, click it
click <theme-toggle-ref>
```

## Why agents need flexibility
An agent shouldn't be told "use approach 1". Instead, they should:
1. First try `emulateMedia` (works for standards-compliant sites)
2. Check if the site uses class-based themes: `eval "() => document.documentElement.className"`
3. Look for a theme toggle in the snapshot
4. Fall back to localStorage/cookie manipulation

## The four-screenshot matrix
For comprehensive UI testing, agents should capture:
| Viewport | Theme | Filename pattern |
|----------|-------|-----------------|
| Desktop (1280x720) | Light | `desktop-light.png` |
| Desktop (1280x720) | Dark | `desktop-dark.png` |
| Mobile (375x812) | Light | `mobile-light.png` |
| Mobile (375x812) | Dark | `mobile-dark.png` |

## Impact on agent prompt
Don't prescribe ONE dark mode method. Give agents the hierarchy of approaches and let them figure out which works for the specific site. The agent should try `emulateMedia` first (broadest compatibility), then fall back.
