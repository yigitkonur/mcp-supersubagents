# Don't prescribe ONE way — give agents a hierarchy of approaches

## The problem with rigid instructions
If you tell an agent "to enable dark mode, run: `eval "() => document.documentElement.classList.add('dark')"`", the agent will try exactly that and fail on sites that use a different dark mode mechanism.

## Better: teach a decision tree

### Example: Dark mode
```
1. Try emulateMedia first (broadest compatibility):
   run-code 'async (page) => { await page.emulateMedia({ colorScheme: "dark" }); }'

2. If that doesn't visually change anything, check for class-based themes:
   eval "() => document.documentElement.className"
   → If site uses Tailwind/class-based: add the class

3. If no class-based theme, look for a toggle in the snapshot:
   → Find and click the theme toggle button

4. If no toggle visible, check localStorage:
   eval "() => JSON.stringify(localStorage)"
   → Look for theme-related keys and set them
```

### Example: Verifying navigation
```
1. Check eval (ground truth):
   eval "() => window.location.href"

2. Check "Open tabs" section if using multiple tabs
   (Don't trust "Page URL" header in multi-tab mode)

3. Check page title:
   eval "() => document.title"
```

### Example: Checking for errors
```
1. Check page content (most reliable for soft 404s):
   eval "() => document.title"

2. Check HTTP status via run-code (for hard errors):
   run-code 'async (page) => { const r = await page.goto(url); return r.status(); }'

3. Check console for JavaScript errors:
   console error
```

## Why this matters
Agents are good at following decision trees. They're bad at recovering from "the one prescribed method doesn't work." Give them a ranked list of approaches with fallbacks.

## Impact on agent prompt
For each testing pattern, provide 2-3 approaches ranked by reliability, not one rigid instruction. Let the agent try the most reliable first and fall back.
