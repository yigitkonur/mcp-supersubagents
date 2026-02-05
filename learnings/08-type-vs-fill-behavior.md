# type appends to focused element; fill replaces on targeted element

## Initial assumption
I didn't have a clear mental model of the difference. Both seem to put text in fields.

## What actually happened

### fill <ref> <text>
- Targets a specific element by ref
- REPLACES all existing content
- Uses Playwright's `locator.fill()` which clears first
- Has `--submit` flag to press Enter after

```bash
fill e53 "Hello"          # Field value: "Hello"
fill e53 "World"          # Field value: "World" (replaced, not appended)
```

### type <text>
- Types into whatever element currently has focus (NO ref parameter)
- APPENDS to existing content (like physical keyboard typing)
- Uses Playwright's `keyboard.type()`
- Also has `--submit` flag

```bash
click e53                 # Focus the field
type "Hello "             # Field value: "Hello "
type "World"              # Field value: "Hello World" (appended)
```

## When to use which

**fill** — For setting form field values directly. Cleaner, more reliable, doesn't depend on focus state.

**type** — For testing keyboard input behavior, autocomplete triggers, input event handlers, character-by-character validation. Also needed when typing into contenteditable divs or elements that `fill` doesn't support.

## Impact on agent prompt
Agents should default to `fill` for form testing (more reliable, targets by ref). Use `type` only when testing keyboard-specific behavior or when the element doesn't support `fill`.
