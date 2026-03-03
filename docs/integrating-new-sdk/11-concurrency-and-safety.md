# Concurrency Patterns and Safety

This document catalogs the subtle concurrency patterns a provider must follow to avoid race conditions, memory leaks, and protocol violations.

---

## 1. Boolean Guards

The system uses boolean flags to prevent concurrent execution of critical sections:

| Guard | Location | Prevents |
|-------|----------|----------|
| `rotationInProgress` | `SessionBinding` | Concurrent rotations from multiple error events |
| `isUnbound` | `SessionBinding` | Double-unbind/double-destroy races |
| `errorHandlingInProgress` | `SessionBinding` | session.idle racing with handleSessionError |
| `fallbackAttempted` | `TaskState` | Multiple concurrent Claude fallback triggers |
| `isShuttingDown` | `SDKClientManager` | New sessions during shutdown |
| `isCompleted` | `SessionBinding` | Double-completion from idle+shutdown race |
| `proactiveRotationAttempted` | `SessionBinding` | Repeated proactive rotations from usage events |

**Pattern:**

```typescript
if (guard) return;      // Check before first await
guard = true;           // Set immediately
try {
  await someAsyncWork();
} finally {
  guard = false;        // Clear in finally
}
```

## 2. CC-017: Event Serialization

The session adapter serializes all events through a Promise chain:

```typescript
// sdk-session-adapter.ts:246-253
let eventChain: Promise<void> = Promise.resolve();

const unsubscribe = session.on((event: SessionEvent) => {
  eventChain = eventChain.then(() =>
    this.handleEvent(taskId, event, binding)
  ).catch((err) => {
    console.error(`Error handling event ${event.type}:`, err);
  });
});
```

**Why:** Without this, `handleSessionError` yields at `await triggerClaudeFallback()` and `handleSessionIdle` runs during that yield, marking the task `COMPLETED` before the error handler finishes. The guard `errorHandlingInProgress` provides an additional safety net.

**For your provider:** If your SDK emits events concurrently (on multiple threads or via microtasks), serialize them. If your SDK uses a sequential stream (`for await`), this is handled naturally.

## 3. The "Terminal State Check After Await" Pattern

After any `await`, the task may have been cancelled, timed out, or completed by another code path:

```typescript
// Pattern used throughout the codebase
await someAsyncWork();

// ALWAYS re-fetch and check
const task = taskManager.getTask(taskId);
if (!task || isTerminalStatus(task.status)) {
  // Clean up and return — don't continue
  return;
}

// Safe to proceed
```

This pattern appears dozens of times in `sdk-session-adapter.ts` and `sdk-spawner.ts`. Every `await` in your provider should be followed by this check if the subsequent code modifies task state.

## 4. `setImmediate` for Non-Blocking Task ID Return

```typescript
// sdk-spawner.ts:259
setImmediate(() => {
  const current = taskManager.getTask(taskId);
  if (!current || isTerminalStatus(current.status)) return;
  runSDKSession(taskId, ...).catch(...);
});

return taskId;  // Returns immediately to MCP client
```

**Why:** Without `setImmediate`, the `spawn_agent` tool call blocks until the session is created and the prompt is sent. This can take seconds and may cause MCP client timeouts.

**For your provider:** Always return the task ID immediately. Use `setImmediate` to defer execution.

## 5. `queueMicrotask` for Dependency Batch Processing

```typescript
// task-manager.ts
taskManager.updateTask(taskId, { status: TaskStatus.COMPLETED });
// Internally triggers:
queueMicrotask(() => this.processWaitingTasks());
```

Using `queueMicrotask` instead of direct calls allows multiple task completions in the same tick to batch their dependency checks into a single pass.

## 6. Write Chain Serialization

Both persistence and output files use Promise chains for serialization:

**Task persistence (`task-persistence.ts`):**
```typescript
// Per-filePath write chain
writeChain = writeChain.then(() => writeState());
```

**Output files (`output-file.ts`):**
```typescript
// Per-task write queue
enqueueWrite(key, () => appendToFile());
```

This prevents concurrent writes from interleaving or corrupting files. The pattern also enables write coalescing — if a write is queued while one is in progress, subsequent requests replace the queued write rather than adding to the queue.

## 7. Single-Flight Guards

Beyond boolean guards, some operations use task-level state as a flight guard:

**`fallbackAttempted` on TaskState:**
```typescript
// fallback-orchestrator.ts
if (task.fallbackAttempted) return false;  // Already attempted
taskManager.updateTask(taskId, { fallbackAttempted: true });
// Only one fallback per task lifetime
```

**`timingOutTasks` Set:**
```typescript
// task-manager.ts
if (timingOutTasks.has(taskId)) return;  // Already timing out
timingOutTasks.add(taskId);
try { await handleTimeout(taskId); }
finally { timingOutTasks.delete(taskId); }
```

## 8. Idempotent Cleanup

```typescript
// sdk-session-adapter.ts:1611-1617
unbind(taskId: string): void {
  const binding = this.bindings.get(taskId);
  if (!binding) return;           // No binding — nothing to do
  if (binding.isUnbound) return;  // Already unbound — idempotent
  binding.isUnbound = true;
  // ... cleanup ...
}
```

`unbind()` is safe to call multiple times. This is important because cleanup can be triggered from multiple paths (session.idle, session.error, session.shutdown, abort, external cancel).

**For your provider:** Make your cleanup function idempotent. Set a guard flag before any cleanup work.

## 9. Timer `.unref()` Requirement

```typescript
// Any setInterval/setTimeout MUST call .unref()
const timer = setInterval(() => { ... }, 60_000);
timer.unref();  // Don't prevent process exit
```

Without `.unref()`, the timer keeps the Node.js event loop alive and prevents graceful shutdown. This is a system-wide requirement — every timer in the codebase uses `.unref()`.

## 10. Circular Dependency Prevention

Services import each other's singletons directly. Circular imports are broken with lazy imports:

```typescript
// Instead of top-level import (which would create a circular dep):
// import { claude-code-runner } from './claude-code-runner.js';

// Use lazy import inside the method:
async someMethod() {
  const { runClaudeCodeSession } = await import('./claude-code-runner.js');
  await runClaudeCodeSession(...);
}
```

If your provider imports from services that also import from your provider, use this pattern.

## 11. Error Handling Tiers

| Tier | Pattern | When |
|------|---------|------|
| **Swallow** | `try { ... } catch { /* swallow */ }` | Cleanup/shutdown paths that must not block |
| **Log and continue** | `catch(err) { console.error('[service] ...', err); }` | Non-critical paths |
| **Propagate** | `throw` or `return { success: false }` | API boundaries (tool handlers, MCP requests) |

Examples:
- **Swallow:** `session.destroy().catch(() => {})` during cleanup
- **Log and continue:** Failed metrics update during session
- **Propagate:** Invalid task ID in `send_message` handler

## 12. Security Constraints

### PAT Tokens Never in Logs

```typescript
// NEVER log raw tokens:
console.error(`Token: ${token}`);  // ← FORBIDDEN

// Use masked form:
console.error(`Token: ${accountManager.getMaskedCurrentToken()}`);  // ← Safe
// Output: "Token: ghp_***abc"
```

Review any code touching `exportCooldownState()` or token iteration.

### `console.error` Only

All logging must use `console.error` (stderr). `console.log` writes to stdout and corrupts the MCP JSON-RPC framing, silently breaking all connected clients.

```typescript
console.error('[your-provider] Starting session...');  // ← Correct
console.log('[your-provider] Starting session...');    // ← BREAKS MCP PROTOCOL
```

### Path Traversal Prevention

Template loading validates paths to prevent directory traversal:

```typescript
// The specialization parameter is used in join(__dirname, 'overlays', ...)
// Any modification must prevent: '..', '/', '\' in the specialization
```

If your provider loads any files based on user input, validate paths similarly.

---

**Previous:** [10 — Mode System and Templates](./10-mode-system-and-templates.md) · **Next:** [12 — Cookbook: Adding a Provider](./12-cookbook-adding-a-provider.md)
