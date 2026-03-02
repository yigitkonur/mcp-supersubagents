# Domain 04: State Machine Integrity

## State Transition Matrix

```
                 PENDING  WAITING  RUNNING  COMPLETED  FAILED  CANCELLED  TIMED_OUT  RATE_LTD
FROM ↓
PENDING            -        ✅       ✅        ✗        ✅       ✅          ✅         ✗
WAITING           ✅        -        ✅*       ✗        ✅       ✅          ✅         ✗
RUNNING            ✗        ✗        -        ✅        ✅       ✅          ✅         ✅
RATE_LIMITED       ✗        ✗       ✅         ✗        ✅       ✅         ✅†         -
COMPLETED          ✗        ✗        ✗         -        ✗        ✗          ✗         ✗
FAILED             ✗        ✗        ✗         ✗        -        ✗          ✗         ✗
CANCELLED          ✗        ✗        ✗         ✗        ✗        -          ✗         ✗
TIMED_OUT          ✗        ✗        ✗         ✗        ✗        ✗          -         ✗

✅ = allowed   ✗ = rejected (logged)   * = declared but never used   † = ADDED in this fix
```

**Key change:** RATE_LIMITED → TIMED_OUT was added to allow health check timeout of stuck rate-limited tasks.

## Terminal State Protection

| Protection Layer | Status |
|-----------------|--------|
| Status transition validation (VALID_TRANSITIONS) | ✅ Solid |
| Non-status field mutation on terminal tasks | ⚠️ Intentional (completionMetrics written post-terminal) |
| appendOutput on terminal tasks | ✅ **FIXED** — 5s grace then blocked |
| processWaitingTasks skips terminal | ✅ Solid |
| Health check re-checks terminal before timeout | ✅ Solid |
| Late SDK events blocked by isUnbound/isCompleted | ✅ Solid |

## Findings

| # | Severity | File | Finding | Status |
|---|----------|------|---------|--------|
| F-1 | **HIGH** | task-manager.ts | processWaitingTasks synchronous recursion → stack overflow on deep chains | **FIXED** |
| F-2 | MEDIUM | task-manager.ts | appendOutput no terminal status check | **FIXED** |
| F-3 | MEDIUM | task-manager.ts | Health check doesn't timeout PENDING/RATE_LIMITED tasks | **FIXED** |
| F-4 | MEDIUM | task-manager.ts | Object.assign unconditional for non-status fields on terminal tasks | Documented (intentional) |
| F-5 | LOW | task-manager.ts | WAITING→RUNNING declared but never used (dead transition) | — |
| F-6 | LOW | task-persistence.ts | Restart recovery: stale retryInfo timings | **FIXED** (jitter) |
| F-7 | LOW | task-manager.ts | timingOutTasks Set TOCTOU between check and mutation | — (theoretical) |

## Dependency Resolution

- DFS cycle detection is exhaustive (visited + visiting sets)
- Terminal tasks treated as leaf nodes (correct)
- RATE_LIMITED dependencies: task stays WAITING until dep resolves (retry → RUNNING → COMPLETED)
- `processWaitingTasks` now uses `queueMicrotask` for ALL terminal cascades (FIXED)

## Corner Cases (15)

1. Recursive cascade A→B→C…→Z dependency failure — **FIXED** via queueMicrotask
2. appendOutput on COMPLETED task by late SDK event — **FIXED** with 5s grace guard
3. PENDING task never executes (setImmediate lost) — **FIXED**: health check now times out PENDING
4. RATE_LIMITED past timeoutAt — **FIXED**: health check now handles RATE_LIMITED
5. Restart recovery with stale timings — **FIXED**: jitter added
6. send_message spawns new task while cleanup in progress — Safe (independent task)
7. forceStartTask + processWaitingTasks race — Safe (terminal guard in executeWaitingTask)
8. session.idle + session.shutdown in quick succession — Safe (isCompleted guard)
9. Health check + adapter both timeout same task — Safe (timingOutTasks Set + terminal guard)
10. Object.assign re-attaches session to terminal task — Minor memory leak; documented
11. Proactive rotation + normal rotation race — Safe (rotationInProgress guard)
12. WAITING→RUNNING declared but dead — Cosmetic; documented
13. statusChangeCallback re-entrant updateTask — Safe (transition validated per call)
14. send_message on RATE_LIMITED + auto-retry — **FIXED** (marks FAILED first)
15. Claude fallback abort vs stream completion — Safe (terminal check in both paths)
