# tab-new <url> opens about:blank, not the URL

## Initial assumption
I assumed `tab-new https://example.com` would create a new tab AND navigate to that URL, similar to Ctrl+clicking a link or opening a new browser tab with a URL.

## What actually happened
```bash
playwright-cli tab-new https://zeo-nextjs-theta.vercel.app/hello
# Result:
# - 0: [What is SEO?...](https://zeo-nextjs-theta.vercel.app/seo)
# - 1: (current) [](about:blank)
```
The tab was created and made current, but it loaded `about:blank` — NOT the provided URL.

## The fix
After `tab-new`, you must explicitly navigate:
```bash
playwright-cli tab-new
playwright-cli open https://zeo-nextjs-theta.vercel.app/hello
```

## Why this matters for agents
An agent following intuition would assume `tab-new <url>` does the full job. They'd then snapshot `about:blank` and get confused about why the page is empty. This is a silent failure — no error is thrown.

## Impact on agent prompt
This MUST be in the gotchas section. It's a two-step operation that looks like it should be one step. The agent needs to know: `tab-new` creates the tab, `open` navigates it.
