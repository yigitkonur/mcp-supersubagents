# Resilience & Fallback Deep-Dive Audit — Executive Summary

**Date:** 2026-03-02
**Scope:** Complete resilience, fallback, concurrency, resource management, state machine, and persistence audit
**Files analyzed:** 15 source files across 7 service domains
**Methodology:** 5 parallel domain-expert agents with warpgrep-driven code context

## Findings Overview

| Severity | Count | Fixed | Documented |
|----------|-------|-------|------------|
| CRITICAL | 1     | ✅    | ✅         |
| HIGH     | 8     | ✅    | ✅         |
| MEDIUM   | 7     | ✅    | ✅         |
| LOW      | ~20   | —     | ✅         |

**All 16 CRITICAL/HIGH/MEDIUM findings fixed and verified.**

## Top 3 Findings

1. **CRITICAL: send_message vs auto-retry double-spawn** — A RATE_LIMITED task could be simultaneously resumed by user (`send_message`) and by the auto-retry scheduler, creating duplicate tasks running the same prompt. Fixed by marking the original FAILED before spawning.

2. **HIGH: Silent stall after rotation send failure** — `rebindWithNewSession` swallowed `send()` failures, leaving tasks RUNNING but with no prompt sent (30-min stall). Fixed by propagating failure and cleaning up orphaned sessions.

3. **HIGH: Task ID collision on restart** — ~196K ID space with no collision check could overwrite persisted tasks after restart. Fixed with 10x expanded space and `generateUniqueTaskId()` collision guard.

## Audit Domains

- **[01] Fallback Chain** — 15 findings (rate limit → PAT rotation → Claude handoff → session resume)
- **[02] Concurrency** — 6 findings (rotation/rebind races, flag ordering, timer interactions)
- **[03] Resource Management** — 10 findings (PTY FDs, file handles, timers, memory)
- **[04] State Machine** — 7 findings (transitions, terminal protection, dependencies)
- **[05] Persistence** — 12 findings (data loss windows, corruption, recovery)

## Files Modified

| File | Fixes Applied |
|------|--------------|
| `src/tools/send-message.ts` | CRITICAL double-spawn guard, HIGH provider/session checks |
| `src/services/fallback-orchestrator.ts` | MEDIUM fallbackAttempted ordering |
| `src/services/sdk-session-adapter.ts` | HIGH send failure propagation in rebind |
| `src/services/sdk-client-manager.ts` | HIGH PTY recycling fallback |
| `src/services/task-manager.ts` | HIGH processWaitingTasks recursion, HIGH persist logging, MEDIUM terminal appendOutput guard, MEDIUM health check expansion, MEDIUM clearAllTasks persist, MEDIUM jitter |
| `src/services/task-persistence.ts` | HIGH corrupt file backup, MEDIUM writeFile |
| `src/utils/task-id-generator.ts` | HIGH collision-safe ID generation |
| `src/index.ts` | MEDIUM statusUpdateTimers shutdown cleanup |
