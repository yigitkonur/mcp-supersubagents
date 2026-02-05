# Refs invalidate on ANY page change: navigation, reload, SPA routing, hover, session restart

## Initial assumption
I initially thought refs might only change on full page navigations (going to a new URL).

## What actually happened — refs broke in ALL these scenarios:

### 1. After hover (snapshot refresh):
```bash
playwright-cli hover e9           # Hover on Homepage link
playwright-cli eval "..." e20     # "Ref e20 not found" — refs changed!
```
Hover returns a new snapshot, and the new snapshot has new refs. The old ref e20 no longer exists.

### 2. After SPA navigation (client-side routing):
Clicking a menu item navigated from / to /seo. All refs from the homepage snapshot were gone.

### 3. After reload:
```bash
playwright-cli reload
playwright-cli eval "(el) => el.value" e426  # "Ref e426 not found"
```

### 4. After session restart (close + reopen):
After `close` destroyed the session, opening a new one gave completely different ref numbers. The ref e426 that was "First Name" textbox now resolved to a flickity slider div.

### 5. After go-back:
Going back to the previous page produces a fresh snapshot with fresh refs.

## The pattern
Refs are tied to a specific snapshot. ANY action that produces a new snapshot (navigation, reload, hover, click that changes DOM) means old refs are invalid. You MUST re-snapshot and use the new refs.

## Impact on agent prompt
This is already in the gotchas but deserves emphasis. The agent should adopt the habit: after any action that might change the page, take a new snapshot before using refs. The safest pattern is: `action → snapshot → use new refs`.

## The scariest case
Session restart ref collision: same ref number (e426) pointing to a COMPLETELY DIFFERENT element (textbox vs slider div). No error — just the wrong element targeted. This can cause agents to fill text into non-input elements, click wrong buttons, etc.
