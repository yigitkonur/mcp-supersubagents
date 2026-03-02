---
applyTo: "**/*.ts"
---

# TypeScript Review Guidelines

## Type Safety

- Avoid `any` — use `unknown`, generics, or specific interfaces
- Existing `(part as any)` casts in `claude-code-runner.ts` are intentional (unstable SDK types) — do not remove without verifying against the actual SDK version
- New `as any` casts require a comment explaining why they're necessary
- Define interfaces for all data shapes passed between functions
- Use strict null checks: handle `null`/`undefined` explicitly

```typescript
// Avoid
function processEvent(event: any) {
  return event.data;
}

// Prefer
interface SessionEvent { type: string; data: unknown; }
function processEvent(event: SessionEvent): unknown {
  return event.data;
}
```

## Module System

- This project uses ESM (`"type": "module"`) — all imports must use `.js` extensions
- Use `createRequire(import.meta.url)` for JSON imports (e.g., `package.json`)
- Circular dependencies must use lazy `await import()` inside methods, not top-level imports

## Patterns

- Use `const` over `let`; never use `var`
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Prefer `Map` and `Set` over plain objects for dynamic key collections
- Zod v4 is used for validation — use `z.object()` with `.parse()` or `.safeParse()`

## Enums and Constants

- `TaskStatus` is a string enum — compare with enum members, not raw strings
- `TERMINAL_STATUSES` is a Set — use `.has()` for membership checks
- `VALID_TRANSITIONS` is a Record of Sets — all status transitions must be checked against it
