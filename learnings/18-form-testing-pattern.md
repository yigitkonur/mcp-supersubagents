# Form testing: fill, verify, submit pattern

## The reliable pattern
```bash
# 1. Fill all fields
fill e53 "John"
fill e56 "Doe"
fill e59 "john@example.com"
fill e62 "Acme Corp"

# 2. Verify values were set correctly
eval "() => {
  const inputs = document.querySelectorAll('input[type=text], input[type=email]');
  return Array.from(inputs).map(i => ({ name: i.name, value: i.value }));
}"

# 3. Screenshot the filled form (visual evidence)
screenshot --filename=form-filled.png

# 4. Submit
click e64   # Submit button
# or: fill e62 "Acme Corp" --submit   (fills + presses Enter)
```

## Key findings from testing

### fill --submit
The `--submit` flag fills the value AND presses Enter:
```bash
fill e53 "Test" --submit
# Generated code:
# await locator.fill('Test');
# await locator.press('Enter');
```

### Verifying form state via eval
Don't rely on snapshots for form values — they don't show input values. Use eval:
```bash
eval "(el) => el.value" e53    # Check specific field by ref
# -> "John"
```

### fill vs type for forms
- `fill` is cleaner for setting values (replaces, targets by ref)
- `type` is for testing keyboard behavior (appends, targets focused element)
- For most form testing, use `fill`

## Impact on agent prompt
Teach agents the fill → verify → screenshot → submit pattern. Emphasize that snapshot YAML doesn't show input values — agents MUST use eval to verify form state.
