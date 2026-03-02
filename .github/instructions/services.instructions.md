---
applyTo: "src/services/**/*.ts"
---

# Service Layer Guidelines

## Singleton Pattern

- Every service is a class instantiated once at module scope and exported as a named constant (e.g., `export const taskManager = new TaskManager()`)
- Services import each other's singletons directly — no DI framework
- New inter-service imports must check for circular dependencies and use lazy `await import()` inside methods if needed

## Task State Machine

- Status transitions are enforced by `VALID_TRANSITIONS` map — never bypass it
- Illegal transitions are logged and silently rejected, not thrown
- Terminal statuses (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) cannot transition further
- After token rotation, session ID changes but task ID does not — never assume `sessionId === taskId`

## In-Place Mutation — Load-Bearing

- `updateTask()` uses `Object.assign(task, updates)` — **never** replace with spread `{ ...task, ...updates }`
- Creating a new object breaks live references held by `appendOutput()` — causes silent data loss
- Output arrays use `splice(0, excess)` — never `slice(-limit)` which allocates new arrays

## Async Race Prevention

- Use boolean guards (`isProcessing`, `isClearing`, `isShuttingDown`): check before first `await`, set immediately, clear in `finally`
- Write serialization: `task-persistence.ts` uses `writeChain = writeChain.then(...)`, `output-file.ts` uses `enqueueWrite()`
- Use `queueMicrotask()` to batch dependency checks (not direct invocation)
- Set `binding.isUnbound` atomically before async destroy to prevent race conditions from queued event handlers
- Always re-fetch task from Map after any `await` to detect concurrent cancellation/completion

```typescript
// Async guard pattern
private isProcessing = false;
async processItems(): Promise<void> {
  if (this.isProcessing) return;
  this.isProcessing = true;
  try { /* ... */ } finally { this.isProcessing = false; }
}
```

## Process Kill Escalation

- Kill follows strict sequence: `session.abort()` → `abortController.abort()` → `SIGTERM` → wait 3s → `SIGKILL`
- Never change the escalation order — entries without PIDs (Claude fallback) only have AbortController
