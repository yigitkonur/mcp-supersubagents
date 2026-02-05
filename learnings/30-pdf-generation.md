# PDF generation works and is useful for specific scenarios

## How it works
```bash
playwright-cli pdf
# Result: .playwright-cli/page-2026-02-05T11-53-33-873Z.pdf (~718KB)
```

## Limitations
- Only works in Chromium (not Firefox or WebKit)
- Renders the full page as printed (print stylesheet applies)
- No control over page size, margins, or headers from CLI

## When agents should use it
1. **Capturing full page content for offline review** — sometimes better than screenshots for text-heavy pages
2. **Testing print stylesheets** — PDF reflects print media, so it's a natural way to verify print layout
3. **Generating artifacts for human stakeholders** — more professional than screenshots for reports

## When NOT to use it
- For visual regression testing (screenshots are better)
- For agent self-analysis (can't be read by LLMs)
- For responsive testing (PDF is fixed-width)

## Impact on agent prompt
Mention as an available capability. Useful when the user asks for PDFs or print testing. Not a default testing step.
