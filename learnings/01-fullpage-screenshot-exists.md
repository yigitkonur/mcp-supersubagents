# --full-page flag EXISTS and works

## Initial assumption
My earlier notes (note 04) documented that `--full-page` didn't exist as a flag on the `screenshot` command. I recommended a scroll-and-screenshot workaround: scroll down in increments, take viewport screenshots, stitch them together mentally.

## What actually happened
Running `playwright-cli --help screenshot` revealed:
```
Options:
  --full-page    whether to take a full page screenshot
```

Testing confirmed it works:
```bash
playwright-cli screenshot --full-page
# Result: Full page captured in a single PNG
```

## Why the assumption failed
The original notes were written during an early session where I didn't check `--help` thoroughly. I relied on memory of Playwright's API flags instead of checking the CLI's actual options.

## Impact on agent prompt
This is huge. Instead of teaching agents a complex scroll-and-screenshot loop, we just need them to know `--full-page` exists. The `--help` flag would reveal it, but since it's such a high-value shortcut, it's worth mentioning explicitly.

## Rule for the prompt
Don't teach scroll-and-screenshot as the primary full-page capture method. Mention `screenshot --full-page` as the way to capture entire pages. Reserve scrolling + viewport screenshots for when you need to inspect specific viewport-level rendering (e.g., checking what's above the fold vs below).
