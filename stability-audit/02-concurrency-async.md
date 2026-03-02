# Domain 2: Concurrency & Async Correctness

**Scope:** Race conditions, double-execution bugs, and state divergence  
**Files Audited:** `sdk-session-adapter.ts`, `sdk-client-manager.ts`, `task-manager.ts`, `account-manager.ts`, `retry-queue.ts`, `sdk-spawner.ts`, `process-registry.ts`, `question-registry.ts`, `types.ts`  
**Date:** 2025-07-15

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1     |
| High     | 3     |
| Medium   | 5     |
| Low      | 5     |
| Info     | 1     |

---

## Findings

### CC-001 — Double Retry: Timer-Based + Manual Retry Can Execute Simultaneously

- **Severity:** Critical
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:463-551, 684-726`
- **Current Behavior:** `processRateLimitedTasks()` and `triggerManualRetry()` could both call `retryCallback(task)` for the same task simultaneously — the manual path did not check `isProcessingRateLimits`.
- **Risk:** Two duplicate task executions consuming quota, doing duplicate work, potentially producing conflicting file edits.
- **Fix Applied:** Per-task retry lock added in `task-manager.ts`. Both paths now check a per-task `retryInFlight` flag before calling `retryCallback`.

---

### CC-002 — Event Handler Operates on Cleared Binding Data After Unbind

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:250-389, 1369-1404`
- **Current Behavior:** The `isUnbound` flag was checked at the top of `handleEvent` but not re-checked after `await` points inside nested async functions like `attemptRotationAndResume`.
- **Risk:** Stale binding reference causes spurious rotation attempts, double session destruction, or writing metrics to a dead binding.
- **Fix Applied:** `isUnbound` guard added after 7 await points in `sdk-session-adapter.ts`.

---

### CC-003 — Proactive Rotation Fire-and-Forget Can Race With Session Completion

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:1002-1029`
- **Current Behavior:** When quota dropped below 1%, `session.idle` events bypassed the `isPaused` check, allowing task completion while rotation was still running.
- **Risk:** Orphaned SDK session consuming PTY FDs and quota. Handoff prompt runs against a ghost task.
- **Fix Applied:** `session.idle` now blocked during rotation in `sdk-session-adapter.ts`.

---

### CC-009 — Zombie Sweep Can Race With Completion to Mark Task FAILED After Success

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-client-manager.ts:615-663`
- **Current Behavior:** Zombie sweep destroyed a session without re-checking task status. A successfully completing task could have its session destroyed mid-finalization.
- **Risk:** Final metrics/output lost for a COMPLETED task.
- **Fix Applied:** Fresh status check added before zombie kill in `sdk-client-manager.ts`.

---

### CC-004 — Session Leak in `attemptRotationAndResume` Error Path

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-session-adapter.ts:671-692`
- **Current Behavior:** If `rebindWithNewSession` throws for a non-terminal reason, the catch block returns `false` without destroying the newly created session.
- **Risk:** PTY FD leak if rotation failures are frequent. Each leaked session holds OS file descriptors until the sweeper runs (up to 60s).
- **Recommended Fix:** Add `await sdkClientManager.destroySession(newSession.sessionId).catch(() => {})` in the catch block at line 688.

---

### CC-005 — `reset()` Can Stop Freshly Created Clients

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-client-manager.ts:222-241`
- **Current Behavior:** Tasks in flight during a reset get "Client creation invalidated" error instead of clean retry.
- **Risk:** Confusing error messages instead of graceful retry.
- **Recommended Fix:** Have `runSDKSession` recognize "invalidated by reset/shutdown" errors and retry getClient() once.

---

### CC-006 — Health Check Timeout IIFE Races With Normal Session Abort

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:822-864`, `src/services/sdk-session-adapter.ts:1437-1469`
- **Current Behavior:** Both `markTimedOut` and the health check IIFE can abort/kill the same process. Double `session.abort()` calls and duplicate SIGTERM signals are sent.
- **Risk:** Minor resource waste. No state corruption due to terminal status guard.
- **Recommended Fix:** Have `markTimedOut` check `timingOutTasks` or the health check check the adapter's `isCompleted` flag before proceeding.

---

### CC-010 — `send_message` Can Resume a Task That Is Mid-Rotation

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-session-adapter.ts` (rotation state), `src/tools/send-message.ts`
- **Current Behavior:** User's `send_message` can capture a stale session reference before `rebindWithNewSession` completes. The prompt is sent to the old (destroyed) session.
- **Risk:** User message lost during rotation with no error returned.
- **Recommended Fix:** Check `binding.rotationInProgress` or `binding.isPaused` and return an error asking the user to retry.

---

### CC-013 — Stale Snapshot in `processRateLimitedTasks` Can Miss State Changes

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:463-551`
- **Current Behavior:** After awaiting `retryCallback`, the loop continues with stale snapshot data for remaining tasks. An expedited retry time could be missed.
- **Risk:** Slightly delayed retry (up to one retry cycle). No double-execution or missed retry.
- **Recommended Fix:** Re-fetch the task inside the loop body before calling `shouldRetryNow(task)`.

---

### CC-014 — `Object.assign` Status Update + Callback Re-entrancy

- **Severity:** Medium
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:1046-1127`
- **Current Behavior:** The `task` object passed to `statusChangeCallback` is a mutable reference. A future callback implementation that caches the reference could see unexpected state changes.
- **Risk:** Low. Internal callback system, callers are aware of mutation semantics.
- **Recommended Fix:** Document that the `task` object passed to `statusChangeCallback` is mutable and should not be cached. Or pass a shallow copy.

---

### CC-008 — `processWaitingTasks` + `executeCallback` Fire-and-Forget

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:317-375`
- **Current Behavior:** Status checks prevent actual double-start. No correctness issue.
- **Risk:** None in practice due to status transition guards.

---

### CC-011 — Question Cleanup Race on Cancellation Path

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/task-manager.ts:1206-1290`, `src/services/question-registry.ts`
- **Current Behavior:** Brief inconsistency window where cancelled task still shows `pendingQuestion`.
- **Risk:** Minor — user sees a cancelled task with a pending question momentarily.
- **Recommended Fix:** Have `cancelTask` directly call `questionRegistry.clearQuestion(taskId, 'task cancelled')` before returning.

---

### CC-012 — `cleanup()` in `questionRegistry` Doesn't Set `settled` Flag

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/question-registry.ts:348-355`
- **Current Behavior:** `cleanup` doesn't set `binding.settled = true` before rejecting. Safe due to Promise idempotency.
- **Risk:** None in practice.
- **Recommended Fix:** Set `binding.settled = true` in `cleanup` for consistency.

---

### CC-015 — `sweepStaleSessions` Iterates While Mutating the Sessions Map

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-client-manager.ts:571-672`
- **Current Behavior:** During async suspension in the loop, new sessions could be added to the map. Undefined iterator behavior per spec.
- **Risk:** Theoretical. In practice, no incorrect behavior expected.
- **Recommended Fix:** Take a snapshot: `for (const [sessionId, session] of Array.from(entry.sessions))`.

---

### CC-016 — No Guard Against Concurrent `attemptRotationAndResume` From Different Code Paths

- **Severity:** Low
- **Status:** ⚠️ Open
- **Location:** `src/services/sdk-session-adapter.ts:489, 911, 1005`
- **Current Behavior:** The `isUnbound` check in the `.then()` handler properly guards against operating on a stale binding.
- **Risk:** Minimal due to `isUnbound` guard.

---

### CC-007 — `accountManager.rotateToNext()` Has No Concurrency Guard

- **Severity:** Info
- **Status:** ⚠️ Open
- **Location:** `src/services/account-manager.ts:199-282`
- **Current Behavior:** `rotateToNext` is synchronous with no await points. Safe in single-threaded JS.
- **Risk:** None.
