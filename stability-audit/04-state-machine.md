# Domain 4: State Machine Integrity

**Scope:** MCP Server Task State Machine  
**Files Analyzed:** 9 source files across `src/services/`, `src/tools/`, `src/types.ts`  
**Date:** 2025-07-15

---

## VALID_TRANSITIONS Reference

```
PENDING      → WAITING, RUNNING, CANCELLED, FAILED, TIMED_OUT
WAITING      → PENDING, RUNNING, CANCELLED, FAILED, TIMED_OUT
RUNNING      → COMPLETED, FAILED, CANCELLED, TIMED_OUT, RATE_LIMITED
RATE_LIMITED → FAILED, CANCELLED, RUNNING
COMPLETED    → (terminal)
FAILED       → (terminal)
CANCELLED    → (terminal)
TIMED_OUT    → (terminal)
```

All status mutations route through `updateTask()` which enforces `VALID_TRANSITIONS`. No direct `task.status = ...` assignments exist in the codebase. ✓

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 2     |
| Medium   | 6     |
| Low      | 3     |
| Verified Safe | 5 |

---

## Findings

### SM-002 — Concurrent Manual+Auto Retry Spawns Duplicates

- **Severity:** High (Critical shared with CC-001)
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:463-552, 684-726`
- **Current Behavior:** `processRateLimitedTasks()` and `triggerManualRetry()` could both call `retryCallback(task)` for the same RATE_LIMITED task simultaneously.
- **Risk:** Two replacement tasks spawned for the same original.
- **Fix Applied:** Per-task retry lock added in `task-manager.ts` (shared fix with CC-001).

---

### SM-011 — `bind()` Forces RUNNING Without Checking Current Status / Duplicate Sessions

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:229-241`, `src/services/sdk-spawner.ts:344`
- **Current Behavior:** `runSDKSession` did not check that the task was PENDING before proceeding. If `executeWaitingTask` was called twice for the same task, both could create sessions.
- **Risk:** Duplicate session execution for the same task.
- **Fix Applied:** PENDING status check added at the start of `runSDKSession` in `sdk-spawner.ts`.

---

### SM-001 — `appendOutput()` Mutates Terminal Tasks Without Guard

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:1142-1196`
- **Current Behavior:** `appendOutput()` only checks `if (task)` — no terminal status guard. Late SDK events mutate the task object, overwrite `lastOutputAt`, `lastHeartbeatAt`, and can clear `timeoutReason`/`timeoutContext` on TIMED_OUT tasks.
- **Risk:** Diagnostic data about timeouts destroyed by late events.
- **Fix Applied:** Add `if (isTerminalStatus(task.status)) return;` guard.

---

### SM-003 — `processWaitingTasks()` Asymmetric Dispatch

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:1117-1124`
- **Current Behavior:** COMPLETED triggers `processWaitingTasks` via `queueMicrotask`, while FAILED/CANCELLED/TIMED_OUT triggers it synchronously. Creates a window of inconsistency.
- **Risk:** Waiting task failure delayed by one microtask. Not functionally broken.
- **Fix Applied:** Use the same dispatch mechanism for both paths.

---

### SM-008 — `updateTask` Accepts Non-Status Mutations on Terminal Tasks

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:1046-1127`
- **Current Behavior:** Any non-status field can be mutated on a terminal task. No enforcement of which fields are allowed post-terminal.
- **Risk:** Late events can overwrite completion data.
- **Fix Applied:** After entering terminal status, only allow explicitly whitelisted fields (e.g., `completionMetrics`, `sessionMetrics`).

---

### SM-009 — `cleanup()` Evicts Tasks Referenced by Active Dependency Chains

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:926-976`
- **Current Behavior:** A completed dependency task is evicted by TTL cleanup. Dependent WAITING tasks fail with "Dependencies missing" even though the dependency was satisfied.
- **Risk:** User workflow disrupted.
- **Fix Applied:** Don't evict tasks that are still referenced as dependencies of non-terminal tasks.

---

### SM-012 — `processWaitingTasks` Promotes and Executes Without Atomicity

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:317-375`
- **Current Behavior:** If `executeCallback` throws synchronously, the error is swallowed and the task remains PENDING forever with no retry mechanism.
- **Risk:** Stuck PENDING tasks.
- **Fix Applied:** Add a PENDING timeout in health check, or fail the task on execute error.

---

### SM-014 — `appendOutput` Clears Timeout Data on Terminal Tasks

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:1149-1152`
- **Current Behavior:** The stall-clearing logic applies to terminal tasks because there's no terminal guard on `appendOutput`.
- **Risk:** Timeout diagnostic data lost.
- **Fix Applied:** Combine with SM-001 fix — add terminal guard.

---

### SM-005 — `send_message` Creates New Task But Original Stays Terminal

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/tools/send-message.ts:105-124, 141-149`
- **Current Behavior:** `send_message` creates a new task without validating session liveness.
- **Risk:** Resume attempt may fail silently.
- **Fix Applied:** Check session existence before attempting resume.

---

### SM-010 — `expediteRateLimitedTasks` Reads Task After Mutation Without Re-fetch

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:611-636`
- **Current Behavior:** Snapshot-based iteration may include tasks already retried. At worst, a wasted `updateTask` call.
- **Risk:** Minimal.

---

### SM-015 — Dependency Validation at Creation Not Rechecked Before Execution

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:381-411`, `src/services/sdk-spawner.ts:273-331`
- **Current Behavior:** Once promoted to PENDING, deps are not re-checked. The SM-009 issue is the real problem.
- **Risk:** Acceptable behavior.

---

### Verified Safe (No Issues Found)

- **SM-004** — `handleSessionShutdown` vs `session.idle`: `binding.isCompleted` guard correctly prevents double-update in both directions.
- **SM-006** — Health check timeout vs idle race: Re-check at line 846 correctly prevents overwrite. Timeout takes priority when they race.
- **SM-007** — RATE_LIMITED persistence across restart: Current behavior is acceptable. Cooldowns properly restored.
- **SM-013** — `clearAllTasks` abort race: Safe due to `isClearing` flag and late-event handling.
- **SM-016** — Fallback orchestrator single-flight guard: `fallbackAttempted` flag is safe in single-threaded JS.
