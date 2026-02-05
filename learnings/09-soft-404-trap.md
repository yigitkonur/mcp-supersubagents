# Soft 404s: HTTP 200 on error pages

## What happened
```bash
playwright-cli run-code 'async (page) => {
  const resp = await page.goto("https://zeo-nextjs-theta.vercel.app/nonexistent");
  return { status: resp.status() };
}'
# -> { status: 200 }
```

The page showed "Lost your way?" (clearly a 404) but the HTTP status was 200.

## Why this matters
Many Next.js / SPA sites return 200 for all routes and handle 404s client-side. An agent checking only `response.status()` would think the page loaded successfully.

## The right way to detect 404s
Check page content, not HTTP status:
```bash
# Check title
eval "() => document.title"
# -> "Page Not Found | Zeo"

# Check for error-indicating content
eval "() => document.querySelector('h2')?.textContent"
# -> "Lost your way?"
```

## Impact on agent prompt
When testing for broken links or 404 handling, agents should check page content (title, heading text) rather than HTTP status codes. Many modern frameworks serve 404 pages with 200 status.
