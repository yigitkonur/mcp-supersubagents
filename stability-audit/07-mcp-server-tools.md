# Domain 7: MCP Server, Tool Handlers & Shutdown

**Scope:** MCP protocol handling, tool handlers, shutdown sequence, progress/subscription registries, session hooks  
**Files Audited:** `index.ts`, `tools/*`, `progress-registry.ts`, `subscription-registry.ts`, `client-context.ts`, `session-hooks.ts`  
**Date:** 2025-07-15

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 1     |
| Medium   | 6     |
| Low      | 8     |
| Info     | 4     |

Note: Two findings overlap with other domains (MS-001 ≈ RM-006, MS-015 counts here as the primary location).

---

## Findings

### MS-002 — No Force-Exit Timeout on SIGINT/SIGTERM Shutdown

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/index.ts:838-863, 877-878`
- **Current Behavior:** SIGINT or SIGTERM arrived, the `shutdown()` function awaited `taskManager.shutdown()` → `shutdownSDK()` sequentially. If either hung, the process hung indefinitely.
- **Risk:** Process becomes unkillable, requiring SIGKILL.
- **Fix Applied:** 30s force-exit timeout added on SIGINT/SIGTERM in `index.ts`.

---

### MS-015 — `processWaitingTasks()` Runs During Shutdown

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:317-375, 1117-1118`
- **Current Behavior:** During shutdown, task transitions triggered `processWaitingTasks()` via microtask. The function had no `isShuttingDown` check, potentially starting new tasks during shutdown.
- **Risk:** Waiting tasks start executing during shutdown, only to be immediately killed.
- **Fix Applied:** `processWaitingTasks` now blocked during shutdown in `task-manager.ts`.

---

### MS-001 — `statusUpdateTimers` Not Cleared During Shutdown

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:160, 838-863`
- **Current Behavior:** Shutdown clears `resourceUpdateTimers` but never clears `statusUpdateTimers`. Debounced timers fire after shutdown.
- **Risk:** MCP notifications sent on closed transport.
- **Recommended Fix:** Add matching cleanup for `statusUpdateTimers`.

---

### MS-003 — `spawn_agent` Accepted During Shutdown

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:299-313`, `src/services/task-manager.ts:978-987`
- **Current Behavior:** No shutdown guard in `CallToolRequestSchema` handler or `createTask()`. Tasks can be created during shutdown.
- **Risk:** Wasted resources, orphaned processes, misleading success response.
- **Recommended Fix:** Check `isShuttingDown` in `createTask()` or at handler top.

---

### MS-006 — `ReadResourceRequestSchema` Handler Lacks Top-Level Error Boundary

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:549-757`
- **Current Behavior:** No top-level `try/catch`. A single malformed task can break all resource reads.
- **Risk:** `task:///all` and `system:///status` become unresponsive.
- **Recommended Fix:** Wrap each resource handler branch in `try/catch`.

---

### MS-008 — `console.error` in Shutdown Path Not Guarded for Broken Stderr

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:841`
- **Current Behavior:** If the broken pipe was on stderr, `console.error` throws and the rest of shutdown (clearing timers, aborting sessions, persisting state) is skipped entirely.
- **Risk:** Child processes not killed, output files not flushed, state not persisted.
- **Recommended Fix:** Wrap `console.error` in shutdown with `try/catch`.

---

### MS-011 — `send_message` TOCTOU: Status Check to SessionId Read

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/tools/send-message.ts:113-134`
- **Current Behavior:** Status is checked at line 113, `sessionId` read at line 134. A concurrent operation can change both between reads.
- **Risk:** Confusing error instead of clear "task state changed" message.
- **Recommended Fix:** Re-read and re-validate the task after acquiring the `resumeInProgress` lock.

---

### MS-013 — `CallToolRequestSchema` Handler Has No Top-Level Exception Boundary

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:299-313`
- **Current Behavior:** If the switch statement throws, the error propagates to the MCP SDK.
- **Risk:** Low probability but defensive coding would add a top-level catch.
- **Recommended Fix:** Wrap the entire handler in try/catch.

---

### MS-021 — No Guard Against Recursive `onStatusChange` During `updateTask`

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:196-238`, `src/services/task-manager.ts:1095-1127`
- **Current Behavior:** `sendNotification` could theoretically trigger a status change (via broken-pipe → shutdown), causing recursive `updateTask` calls.
- **Risk:** Theoretical — `sendNotification` is unlikely to synchronously trigger status changes.
- **Recommended Fix:** Queue status change notifications and flush after `updateTask()` completes.

---

### MS-004 — `CancelTaskRequestSchema` Handler Uses Non-Null Assertion After Cancel

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:346`
- **Current Behavior:** `getTask(taskId)!` after `cancelTask()`. If the task was removed during cancel, this throws.
- **Risk:** MCP protocol error returned as unhandled exception.
- **Recommended Fix:** Guard the return with a null check.

---

### MS-005 — `ListTasksRequestSchema` Cursor Parsing Has No NaN Guard

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:328`
- **Current Behavior:** Malformed cursor yields `NaN`, `slice(NaN, NaN + 50)` returns empty array silently.
- **Risk:** Silent data loss for clients with malformed cursors.
- **Recommended Fix:** Validate parsed cursor and throw on NaN.

---

### MS-007 — `task:///all` Dereferences `pendingQuestion!` Without Guard

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:614-621`
- **Current Behavior:** Between `.filter()` and `.map()`, concurrent state change could clear `pendingQuestion`.
- **Risk:** Extremely unlikely in single-threaded JS.
- **Recommended Fix:** Add null guard inside `.map()`.

---

### MS-010 — Progress Bindings Not Bulk-Cleaned During Shutdown

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/progress-registry.ts`, `src/index.ts:838-863`
- **Current Behavior:** Shutdown nullifies `statusChangeCallback` before terminal-status path can call `unregister()`. Active flush timers leak.
- **Risk:** Noise from failed notifications. Timers are NOT `.unref()`'d.
- **Recommended Fix:** Add `progressRegistry.clear()` to shutdown path.

---

### MS-014 — Subscription Registry Never Cleared on Disconnect

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/subscription-registry.ts`
- **Current Behavior:** Subscriptions accumulate and never clear. Stale subscriptions generate notification errors.
- **Risk:** Noisy error logs for the lifetime of the process.
- **Recommended Fix:** Call `subscriptionRegistry.clear()` in shutdown and on stdin disconnect.

---

### MS-016 — `onExecute` Callback Rejection Not Fully Handled

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:347`, `src/index.ts:150-155`
- **Current Behavior:** If `executeCallback` throws, the `.catch()` swallows the error. Task remains PENDING forever.
- **Risk:** Stuck tasks with no user notification.
- **Recommended Fix:** On execute failure, transition the task to FAILED.

---

### MS-017 — `stdin` Disconnect Handlers Registered After `server.connect(transport)`

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:868-875`
- **Current Behavior:** If stdin closes during `server.connect()`, handlers haven't been registered yet.
- **Risk:** Extremely unlikely. Process would become an orphan.
- **Recommended Fix:** Register stdin handlers before `server.connect()`.

---

### MS-018 — `uncaughtException` Handler Resets Guard on Non-Fatal Path

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:898-924`
- **Current Behavior:** A pathological loop of synchronous uncaught exceptions logs infinitely.
- **Risk:** Disk/stderr fill rapidly.
- **Recommended Fix:** Add a rate limiter (e.g., exit after 10 uncaught exceptions in quick succession).

---

### MS-009 — Progress Flush Timers Can Fire After Task Deletion

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/services/progress-registry.ts:89-98`
- **Current Behavior:** Timer fires on detached binding whose `sendNotification` fails (caught by `.catch()`). Harmless.

---

### MS-012 — `send_message` Creates New Task Without Inheriting Original Configuration

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/tools/send-message.ts:136, 142-149`
- **Current Behavior:** Continuation task doesn't inherit model, autonomous flag, or task type from original.
- **Risk:** A `super-planner` continuation uses default model instead of Opus.
- **Recommended Fix:** Pass `model`, `autonomous`, and `taskType` from original task.

---

### MS-019 — `client-context.ts` URI Parsing Doesn't Handle Windows `file:///` URIs

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/services/client-context.ts:16`
- **Current Behavior:** `file:///C:/Users/foo` becomes `/C:/Users/foo` on Windows.
- **Risk:** Windows-only. Tasks fail with ENOENT.
- **Recommended Fix:** Use `new URL(r.uri).pathname` for cross-platform support.

---

### MS-020 — `session-hooks.ts` Returns Hardcoded `retryCount: 3`

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/services/session-hooks.ts:124-126`
- **Current Behavior:** All recoverable errors get `retryCount: 3` regardless of previous retries.
- **Risk:** Depends on SDK semantics. Could loop indefinitely if SDK resets per-hook-response.
- **Recommended Fix:** Track retry count per task and decrement.
