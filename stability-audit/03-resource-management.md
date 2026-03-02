# Domain 3: Resource Management & Leaks

**Scope:** PTY FD leaks, output file handle leaks, timer leaks, memory retention, AbortController cleanup, event listener leaks, write queue accumulation  
**Files Audited:** `sdk-client-manager.ts`, `output-file.ts`, `process-registry.ts`, `task-manager.ts`, `sdk-session-adapter.ts`, `progress-registry.ts`, `subscription-registry.ts`, `question-registry.ts`, `session-hooks.ts`, `index.ts`, `config/timeouts.ts`  
**Date:** 2025-07-15

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 0     |
| Medium   | 4     |
| Low      | 9     |
| Info     | 3     |

---

## Findings

### RM-001 — PTY Recycler Ignores Clients With Active Sessions

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-client-manager.ts:732`
- **Current Behavior:** `recyclePtyLeakers()` only recycles clients when `entry.sessions.size === 0`. A client whose sessions are leaking PTY FDs will never be recycled because it still has active sessions.
- **Risk:** Gradual PTY FD exhaustion under sustained load.
- **Recommended Fix:** When a client exceeds the threshold and has active sessions, mark those sessions for migration: destroy them, fail associated tasks with retryable error, and recycle the client.

---

### RM-002 — Stale Session Sweeper Double-Failure Leaves Ghost PTY FDs

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-client-manager.ts:585-603`
- **Current Behavior:** Session is removed from tracking before attempting destruction. If both `deleteSession()` and `destroySessionWithRetry()` fail, PTY FDs persist until client restart.
- **Risk:** Leaked PTY FDs, unrecoverable until client recycle.
- **Recommended Fix:** Record the session in a "zombie sessions" set and escalate.

---

### RM-004 — File Handle Not Closed on Write Error

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/output-file.ts:168-179`
- **Current Behavior:** When `appendToOutputFile()` catches a write error, it removes the handle from tracking but never calls `handle.close()`.
- **Risk:** File descriptor leak per I/O error.
- **Recommended Fix:** Close the handle before deleting from tracking maps.

---

### RM-006 — `statusUpdateTimers` Not Cleared During Shutdown

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:160`, `src/index.ts:838-863`
- **Current Behavior:** Shutdown clears `resourceUpdateTimers` but never clears `statusUpdateTimers`. Debounced timers fire after shutdown begins.
- **Risk:** Timer callbacks sending MCP notifications on closed transport.
- **Recommended Fix:** Add matching cleanup in the shutdown handler for `statusUpdateTimers`.

---

### RM-003 — Fire-and-Forget destroySession During Rebind

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-session-adapter.ts:705`
- **Current Behavior:** Old session destroy is fire-and-forget. If it fails, PTY FDs leak.
- **Risk:** Occasional PTY FD leak during rotation. Mitigated by `detectOrphanedSessions()`.
- **Recommended Fix:** Await the destroy call or queue it for retry.

---

### RM-005 — `staleHandleTimer` Not Cleared During Shutdown

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/output-file.ts:274-277`
- **Current Behavior:** `shutdown()` calls `closeAllOutputHandles()` directly, bypassing `shutdownOutputFileCleanup()` which also calls `clearInterval(staleHandleTimer)`. Timer can fire during shutdown, racing with close-all.
- **Risk:** Double-close errors (swallowed but noisy).
- **Recommended Fix:** Call `shutdownOutputFileCleanup()` instead of `closeAllOutputHandles()` in `task-manager.shutdown()`.

---

### RM-007 — Progress Registry `flushTimer` Instances Are Ref'd

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/progress-registry.ts:89`
- **Current Behavior:** `flushTimer` created via `setTimeout()` without `.unref()`.
- **Risk:** Could theoretically delay process exit in edge cases.
- **Recommended Fix:** Add `.unref()` to flush timers or add `progressRegistry.cleanup()` to shutdown.

---

### RM-008 — `warnedTasks` Set Grows Unbounded

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/output-file.ts:16`
- **Current Behavior:** Entries only cleared during shutdown. Each unique write failure adds an entry that is never removed.
- **Risk:** Minor memory growth. Bounded in practice by max tasks.
- **Recommended Fix:** Prune entries when set exceeds 500.

---

### RM-009 — `sessionOwners` Map Entries Orphaned on Task Eviction

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-client-manager.ts:178`
- **Current Behavior:** When tasks are evicted, `sessionOwners` entries persist until the stale session sweeper processes them (up to 60s).
- **Risk:** Minor memory retention (string→string entries).
- **Recommended Fix:** Add cleanup in `taskDeletedCallback`.

---

### RM-010 — Question Timeout Timers Are Ref'd

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/question-registry.ts:74-76`
- **Current Behavior:** Each pending question creates a `setTimeout` (30 minutes) that is NOT `.unref()`'d.
- **Risk:** Process may hang on exit if shutdown fails before `questionRegistry.cleanup()`.
- **Recommended Fix:** Unref the timeout.

---

### RM-011 — `processRegistry` Entries Not Cleaned on Task Eviction

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/process-registry.ts:30`
- **Current Behavior:** Eviction doesn't call `processRegistry.unregister(taskId)`. Non-issue in practice due to process restart semantics.
- **Risk:** Negligible. Safety concern only.
- **Recommended Fix:** Add `processRegistry.unregister(id)` to the eviction loop for defense-in-depth.

---

### RM-012 — `createOutputFile` Opens Handle Outside Persistent System

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/output-file.ts:116-138`
- **Current Behavior:** `createOutputFile()` opens and closes a file handle separately from the persistent handle system. If the close throws, the FD leaks.
- **Risk:** Rare FD leak.
- **Recommended Fix:** Use `try/finally` to ensure the handle is closed.

---

### RM-013 — Event Listeners Orphaned Between Eviction and Session Sweep

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-session-adapter.ts:219-223`
- **Current Behavior:** When `cleanup()` evicts a terminal task, it does NOT call `sdkSessionAdapter.unbind()`. Event handler closures retain SessionBinding objects.
- **Risk:** Retained SessionBinding objects for up to 60s.
- **Recommended Fix:** In `taskDeletedCallback`, call `sdkSessionAdapter.unbind(taskId)`.

---

### RM-014 — `rateLimitTimer` Timeouts Are Ref'd

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:578, 592`
- **Current Behavior:** `rateLimitTimer` not `.unref()`'d. Properly cleared in `shutdown()`.
- **Risk:** Minimal — only matters if process tries to exit without calling shutdown.

---

### RM-015 — Persist Debounce Timer Is Ref'd

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:752`
- **Current Behavior:** `persistTimeout` not `.unref()`'d. Cleared in `shutdown()`.
- **Risk:** Minor event loop retention on crash.

---

### RM-016 — `resourceUpdateTimers` Entries Leak for Deleted Tasks

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/index.ts:159, 174-192`
- **Current Behavior:** Timer fires for evicted task, sending one unnecessary MCP notification. Self-corrects.
- **Risk:** Cosmetic.
- **Recommended Fix:** Clear pending timer in `taskDeletedCallback`.
