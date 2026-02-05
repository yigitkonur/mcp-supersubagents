# Element screenshots use different filename prefix than page screenshots

## What happened
```bash
# Page screenshot:
playwright-cli screenshot
# -> .playwright-cli/page-2026-02-05T12-00-02-456Z.png

# Element screenshot:
playwright-cli screenshot e426
# -> .playwright-cli/element-2026-02-05T12-00-02-456Z.png
```

## The difference
- Page screenshots: `page-*.png`
- Element screenshots: `element-*.png`
- Full page screenshots: `page-*.png` (same as viewport)
- Custom filename: `--filename=whatever.png`

## Why this matters
If an agent is looking for screenshots in the output directory, they need to know both prefixes exist. Also, the `--filename` flag works for both page and element screenshots, giving agents control over naming.

## Best practice for agents
Use `--filename` for organized test evidence:
```bash
screenshot --filename=homepage-desktop.png
screenshot --full-page --filename=homepage-full.png
screenshot e53 --filename=email-field.png
```
This creates a clean, readable set of test artifacts instead of timestamped filenames.
