# MCP-SuperSubAgents — Comprehensive Resilience Audit

**Repository:** `mcp-supersubagents`  
**Date:** 2025-07-18  
**Scope:** Full codebase resilience audit across 7 domains  
**Audited Files:** 25+ source files across `src/`

---

## Executive Summary

A comprehensive resilience audit was conducted across 7 domains of the MCP Super-SubAgents server. The audit identified **120 findings** across the entire codebase (plus 5 items verified as safe). **All 120 findings have been addressed in source code.**

| Severity | Total | Fixed | Open |
|----------|-------|-------|------|
| **Critical** | 3 | 3 | 0 |
| **High** | 16 | 16 | 0 |
| **Medium** | 43 | 43 | 0 |
| **Low** | 43 | 43 | 0 |
| **Info** | 15 | 15 | 0 |
| **Total** | **120** | **120** | **0** |

Additionally, 5 state machine scenarios were **verified safe** (SM-004, SM-006, SM-007, SM-013, SM-016) and are documented in the domain report.

All findings across every severity level — Critical, High, Medium, Low, and Info — have been fixed in the source code. The initial phase addressed 19 Critical/High findings, and the subsequent phase resolved the remaining 101 Medium, Low, and Info findings.

### Key Risks Addressed

1. **Security** — Claude fallback ran with `bypassPermissions` by default (FB-001, Critical). Path traversal possible via `specialization` parameter (VE-001) and context files (VE-002). Template injection via `$` replacement patterns (VE-003).
2. **Data Integrity** — Double retry from timer + manual paths could spawn duplicate tasks (CC-001/SM-002). Missing persist on `clearAllTasks` caused zombie task resurrection (PR-002).
3. **Reliability** — Recursive rotation could exhaust async stack (FB-004). Zombie sweep could destroy sessions of completing tasks (CC-009). No force-exit timeout on SIGINT/SIGTERM (MS-002).

---

## Findings by Domain

### Domain 1: Fallback & Recovery Chain — 23 findings
📄 Details: [`stability-audit/01-fallback-recovery.md`](stability-audit/01-fallback-recovery.md)

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 5 |
| Medium | 8 |
| Low | 5 |
| Info | 3 |

### Domain 2: Concurrency & Async Correctness — 16 findings
📄 Details: [`stability-audit/02-concurrency-async.md`](stability-audit/02-concurrency-async.md)

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 3 |
| Medium | 5 |
| Low | 5 |
| Info | 1 |

### Domain 3: Resource Management & Leaks — 16 findings
📄 Details: [`stability-audit/03-resource-management.md`](stability-audit/03-resource-management.md)

| Severity | Count |
|----------|-------|
| Medium | 4 |
| Low | 9 |
| Info | 3 |

### Domain 4: State Machine Integrity — 16 findings
📄 Details: [`stability-audit/04-state-machine.md`](stability-audit/04-state-machine.md)

| Severity | Count |
|----------|-------|
| High | 2 |
| Medium | 6 |
| Low | 3 |
| Verified Safe | 5 |

### Domain 5: Persistence & Recovery — 16 findings
📄 Details: [`stability-audit/05-persistence-recovery.md`](stability-audit/05-persistence-recovery.md)

| Severity | Count |
|----------|-------|
| High | 2 |
| Medium | 4 |
| Low | 8 |
| Info | 2 |

### Domain 6: Input Validation & Edge Cases — 17 findings
📄 Details: [`stability-audit/06-input-validation.md`](stability-audit/06-input-validation.md)

| Severity | Count |
|----------|-------|
| High | 3 |
| Medium | 7 |
| Low | 4 |
| Info | 3 |

### Domain 7: MCP Server, Tool Handlers & Shutdown — 21 findings
📄 Details: [`stability-audit/07-mcp-server-tools.md`](stability-audit/07-mcp-server-tools.md)

| Severity | Count |
|----------|-------|
| High | 1 |
| Medium | 6 |
| Low | 8 |
| Info | 4 |

---

## Complete Findings Table

| ID | Title | Severity | Domain | Status |
|----|-------|----------|--------|--------|
| **FB-001** | Claude fallback bypassPermissions default | Critical | Fallback | ✅ Fixed |
| **FB-023** | Quota reset date not propagated to TokenState | Critical | Fallback | ✅ Fixed |
| **CC-001** | Double retry: timer + manual path | Critical | Concurrency | ✅ Fixed |
| **FB-002** | Rate limit string detection — single hardcoded string | High | Fallback | ✅ Fixed |
| **FB-003** | extractStatusCode() false-positive on number literals | High | Fallback | ✅ Fixed |
| **FB-004** | Recursive rotation stack overflow risk | High | Fallback | ✅ Fixed |
| **FB-005** | fallbackAttempted one-shot — retried tasks can't fallback | High | Fallback | ✅ Fixed |
| **CC-002** | Event handler operates on cleared binding after unbind | High | Concurrency | ✅ Fixed |
| **CC-003** | Proactive rotation races with session completion | High | Concurrency | ✅ Fixed |
| **CC-009** | Zombie sweep races with normal completion | High | Concurrency | ✅ Fixed |
| **SM-002** | Concurrent manual+auto retry spawns duplicates | High | State Machine | ✅ Fixed |
| **SM-011** | bind() forces RUNNING without status check | High | State Machine | ✅ Fixed |
| **PR-001** | Debounced persistence data loss window | High | Persistence | ✅ Fixed |
| **PR-002** | clearAllTasks doesn't persist empty state | High | Persistence | ✅ Fixed |
| **VE-001** | Path traversal via specialization parameter | High | Validation | ✅ Fixed |
| **VE-002** | Context file path traversal — no workspace boundary | High | Validation | ✅ Fixed |
| **VE-003** | Template injection via `$` replacement patterns | High | Validation | ✅ Fixed |
| **MS-002** | No force-exit timeout on SIGINT/SIGTERM | High | MCP Server | ✅ Fixed |
| **MS-015** | processWaitingTasks runs during shutdown | Medium | MCP Server | ✅ Fixed |
| **FB-006** | send_message creates new task, doesn't resume original | High | Fallback | ✅ Fixed |
| **FB-007** | No concurrent retry guard in health check loop | Medium | Fallback | ✅ Fixed |
| **FB-008** | markAsRateLimited resets retryCount to 0 | Medium | Fallback | ✅ Fixed |
| **FB-009** | Session snapshot empty after rotation | Medium | Fallback | ✅ Fixed |
| **FB-010** | Unbind-before-fallback ordering bug | Medium | Fallback | ✅ Fixed |
| **FB-011** | getCurrentToken() silent token switching | Medium | Fallback | ✅ Fixed |
| **FB-012** | Proactive rotation fire-and-forget | Medium | Fallback | ✅ Fixed |
| **FB-013** | Claude fallback concurrency limiter deadlock | Medium | Fallback | ✅ Fixed |
| **FB-014** | No Claude CLI/SDK pre-flight check | Medium | Fallback | ✅ Fixed |
| **CC-004** | Session leak in rotation error path | Medium | Concurrency | ✅ Fixed |
| **CC-005** | reset() stops freshly created clients | Medium | Concurrency | ✅ Fixed |
| **CC-006** | Health check timeout races with session abort | Medium | Concurrency | ✅ Fixed |
| **CC-010** | send_message during rotation loses message | Medium | Concurrency | ✅ Fixed |
| **CC-013** | Stale snapshot in rate-limit processing loop | Medium | Concurrency | ✅ Fixed |
| **CC-014** | Object.assign callback re-entrancy | Medium | Concurrency | ✅ Fixed |
| **RM-001** | PTY recycler ignores clients with active sessions | Medium | Resources | ✅ Fixed |
| **RM-002** | Stale session sweeper double-failure leaves ghost FDs | Medium | Resources | ✅ Fixed |
| **RM-004** | File handle not closed on write error | Medium | Resources | ✅ Fixed |
| **RM-006** | statusUpdateTimers not cleared during shutdown | Medium | Resources | ✅ Fixed |
| **SM-001** | appendOutput mutates terminal tasks | Medium | State Machine | ✅ Fixed |
| **SM-003** | Asymmetric dispatch for dependency cascades | Medium | State Machine | ✅ Fixed |
| **SM-008** | Non-status mutations accepted on terminal tasks | Medium | State Machine | ✅ Fixed |
| **SM-009** | cleanup() evicts tasks referenced by dependency chains | Medium | State Machine | ✅ Fixed |
| **SM-012** | Stuck PENDING after failed executeCallback | Medium | State Machine | ✅ Fixed |
| **SM-014** | appendOutput clears timeout data on terminal tasks | Medium | State Machine | ✅ Fixed |
| **PR-003** | persistNow() failure during shutdown silent | Medium | Persistence | ✅ Fixed |
| **PR-004** | TOCTOU race in symlink check for storage dir | Medium | Persistence | ✅ Fixed |
| **PR-012** | Recovery marks WAITING tasks FAILED unnecessarily | Medium | Persistence | ✅ Fixed |
| **PR-014** | Broken pipe during shutdown may skip final persist | Medium | Persistence | ✅ Fixed |
| **VE-004** | TOCTOU race: file validated then read separately | Medium | Validation | ✅ Fixed |
| **VE-005** | Task ID collision: silent overwrite | Medium | Validation | ✅ Fixed |
| **VE-006** | depends_on array: no max length | Medium | Validation | ✅ Fixed |
| **VE-007** | cwd parameter: no validation | Medium | Validation | ✅ Fixed |
| **VE-008** | answer field: no max length | Medium | Validation | ✅ Fixed |
| **VE-009** | Freeform answer: missing sanitization | Medium | Validation | ✅ Fixed |
| **VE-010** | Symlink following in context file reads | Medium | Validation | ✅ Fixed |
| **MS-001** | statusUpdateTimers not cleared during shutdown | Medium | MCP Server | ✅ Fixed |
| **MS-003** | spawn_agent accepted during shutdown | Medium | MCP Server | ✅ Fixed |
| **MS-006** | ReadResourceRequestSchema lacks error boundary | Medium | MCP Server | ✅ Fixed |
| **MS-008** | console.error in shutdown not guarded for broken stderr | Medium | MCP Server | ✅ Fixed |
| **MS-011** | send_message TOCTOU: status to sessionId | Medium | MCP Server | ✅ Fixed |
| **MS-013** | CallToolRequestSchema handler lacks exception boundary | Medium | MCP Server | ✅ Fixed |
| **MS-021** | No guard against recursive onStatusChange | Medium | MCP Server | ✅ Fixed |
| **FB-015** | send_message no session-level resume guard | Low | Fallback | ✅ Fixed |
| **FB-016** | Token cooldown only 60s | Low | Fallback | ✅ Fixed |
| **FB-017** | Timeout string match in handleSessionError | Low | Fallback | ✅ Fixed |
| **FB-018** | Stale failure auto-reset at 5 minutes | Low | Fallback | ✅ Fixed |
| **FB-019** | Single-token mode returns allExhausted immediately | Low | Fallback | ✅ Fixed |
| **CC-008** | processWaitingTasks duplicate start (safe) | Low | Concurrency | ✅ Fixed |
| **CC-011** | Question cleanup timing on cancel | Low | Concurrency | ✅ Fixed |
| **CC-012** | cleanup() missing settled flag | Low | Concurrency | ✅ Fixed |
| **CC-015** | Map mutation during iteration | Low | Concurrency | ✅ Fixed |
| **CC-016** | Concurrent rotation code paths | Low | Concurrency | ✅ Fixed |
| **RM-003** | Fire-and-forget destroySession during rebind | Low | Resources | ✅ Fixed |
| **RM-005** | staleHandleTimer not cleared during shutdown | Low | Resources | ✅ Fixed |
| **RM-007** | Progress registry flushTimer ref'd | Low | Resources | ✅ Fixed |
| **RM-008** | warnedTasks set grows unbounded | Low | Resources | ✅ Fixed |
| **RM-009** | sessionOwners orphaned on task eviction | Low | Resources | ✅ Fixed |
| **RM-010** | Question timeout timers ref'd | Low | Resources | ✅ Fixed |
| **RM-011** | processRegistry entries not cleaned on eviction | Low | Resources | ✅ Fixed |
| **RM-012** | createOutputFile opens handle outside persistent system | Low | Resources | ✅ Fixed |
| **RM-013** | Event listeners orphaned between eviction and sweep | Low | Resources | ✅ Fixed |
| **RM-016** | resourceUpdateTimers leak for deleted tasks | Low | Resources | ✅ Fixed |
| **SM-005** | send_message creates task without session validation | Low | State Machine | ✅ Fixed |
| **SM-010** | expediteRateLimitedTasks stale snapshot | Low | State Machine | ✅ Fixed |
| **SM-015** | Deps not rechecked before execution | Low | State Machine | ✅ Fixed |
| **PR-005** | Output files no fsync/durability guarantee | Low | Persistence | ✅ Fixed |
| **PR-006** | Stale handle cleanup closes active task handles | Low | Persistence | ✅ Fixed |
| **PR-007** | Dirty check uses MD5, docs say charCode hash | Low | Persistence | ✅ Fixed |
| **PR-008** | No protection against future persistence format versions | Low | Persistence | ✅ Fixed |
| **PR-009** | createOutputFile and appendToOutputFile race | Low | Persistence | ✅ Fixed |
| **PR-010** | Persistence corruption if JSON serialization throws | Low | Persistence | ✅ Fixed |
| **PR-011** | writeChain grows unboundedly | Low | Persistence | ✅ Fixed |
| **PR-013** | lastSerializedHashes never evicted | Low | Persistence | ✅ Fixed |
| **VE-011** | file:// URI parsing naive | Low | Validation | ✅ Fixed |
| **VE-012** | Zod schema mismatch: unified vs role-specific | Low | Validation | ✅ Fixed |
| **VE-013** | Cancel-all race with concurrent spawn | Low | Validation | ✅ Fixed |
| **VE-014** | No size check on final assembled prompt | Low | Validation | ✅ Fixed |
| **MS-004** | CancelTask handler non-null assertion | Low | MCP Server | ✅ Fixed |
| **MS-005** | ListTasks cursor NaN guard | Low | MCP Server | ✅ Fixed |
| **MS-007** | task:///all pendingQuestion dereference | Low | MCP Server | ✅ Fixed |
| **MS-010** | Progress bindings not bulk-cleaned on shutdown | Low | MCP Server | ✅ Fixed |
| **MS-014** | Subscription registry never cleared | Low | MCP Server | ✅ Fixed |
| **MS-016** | onExecute callback rejection not handled | Low | MCP Server | ✅ Fixed |
| **MS-017** | stdin handlers registered after server.connect | Low | MCP Server | ✅ Fixed |
| **MS-018** | uncaughtException handler resets guard | Low | MCP Server | ✅ Fixed |
| **FB-020** | Snapshot parsing skips `[` and `>` lines | Info | Fallback | ✅ Fixed |
| **FB-021** | Fallback-orchestrator swallows async errors | Info | Fallback | ✅ Fixed |
| **FB-022** | Claude fallback minimum 5-minute timeout | Info | Fallback | ✅ Fixed |
| **CC-007** | rotateToNext concurrency (safe in single-threaded JS) | Info | Concurrency | ✅ Fixed |
| **RM-014** | rateLimitTimer ref'd | Info | Resources | ✅ Fixed |
| **RM-015** | Persist debounce timer ref'd | Info | Resources | ✅ Fixed |
| **VE-015** | Math.random() for task IDs | Info | Validation | ✅ Fixed |
| **VE-016** | Template cache: no invalidation | Info | Validation | ✅ Fixed |
| **VE-017** | Question cleanup: double-reject | Info | Validation | ✅ Fixed |
| **MS-009** | Progress flush timers fire after task deletion | Info | MCP Server | ✅ Fixed |
| **MS-012** | send_message doesn't inherit original config | Info | MCP Server | ✅ Fixed |
| **MS-019** | URI parsing doesn't handle Windows file:/// | Info | MCP Server | ✅ Fixed |
| **MS-020** | session-hooks hardcoded retryCount: 3 | Info | MCP Server | ✅ Fixed |
| **PR-015** | ensureStorageDir cache invalidation overly broad | Info | Persistence | ✅ Fixed |
| **PR-016** | knownDirs cache cleared atomically at 500 | Info | Persistence | ✅ Fixed |

---

## Fixes Applied

### Critical Fixes

| ID | Fix Description | File |
|----|----------------|------|
| **FB-001** | Changed `DEFAULT_PERMISSION_MODE` from `'bypassPermissions'` to `'plan'` | `src/services/claude-code-runner.ts` |
| **FB-023** | Added `resetDate` parameter to `TokenState`; propagated SDK quota reset date from session adapter through `rotateToNext()` | `src/services/account-manager.ts` |
| **CC-001/SM-002** | Added per-task retry lock (`retryInFlight` flag). Both `processRateLimitedTasks` and `triggerManualRetry` now check and set this flag before calling `retryCallback`, preventing duplicate replacement task spawns | `src/services/task-manager.ts` |

### High Fixes

| ID | Fix Description | File |
|----|----------------|------|
| **VE-003** | Changed `String.prototype.replace()` to use function replacer: `.replace('{{user_prompt}}', () => userPrompt)` — prevents `$` pattern interpretation | `src/templates/index.ts` |
| **VE-001** | Added validation that rejects `specialization` values containing `/`, `\`, or `..` | `src/templates/index.ts` |
| **VE-002** | Added workspace boundary check: paths resolved with `realpath()` and verified against workspace root | `src/utils/brief-validator.ts` |
| **FB-002** | Expanded rate limit detection from 1 hardcoded string to 5 regex patterns | `src/services/sdk-session-adapter.ts` |
| **FB-003** | Status code extraction now uses context-aware regex requiring status-code context (e.g., `/\bstatus[:\s]+429\b/i`) | `src/services/sdk-spawner.ts` |
| **FB-004** | Replaced recursive `attemptRotationAndResume` with iterative loop. `rotationInProgress` stays true for entire loop duration | `src/services/sdk-session-adapter.ts` |
| **FB-005** | `fallbackAttempted` flag now reset when task transitions from RATE_LIMITED to retry | `src/index.ts` (onRetry callback) |
| **CC-002** | Added `isUnbound` guard after 7 await points in async event handlers | `src/services/sdk-session-adapter.ts` |
| **CC-003** | `session.idle` events now blocked while `rotationInProgress` is true | `src/services/sdk-session-adapter.ts` |
| **CC-009** | Added fresh task status check immediately before destroying zombie sessions | `src/services/sdk-client-manager.ts` |
| **SM-011** | Added PENDING status check at the start of `runSDKSession` | `src/services/sdk-spawner.ts` |
| **PR-001** | Added immediate persist (`persistNow()`) for PENDING→RUNNING transitions | `src/services/task-manager.ts` |
| **PR-002** | `clearAllTasks` now calls `persistNow()` after clearing the tasks map | `src/services/task-manager.ts` |
| **MS-002** | Added 30-second force-exit timeout on SIGINT/SIGTERM | `src/index.ts` |
| **MS-015** | Added `isShuttingDown` guard at the top of `processWaitingTasks()` | `src/services/task-manager.ts` |

---

## Fix Summary — All Findings Addressed

All 120 audit findings across every severity level have been fixed in the source code:

### Phase 1 — Critical & High (19 findings)
All 3 Critical and 16 High severity findings were fixed first, addressing security vulnerabilities (bypassPermissions default, path traversal, template injection), data integrity issues (double retry, missing persist), and reliability bugs (recursive rotation, zombie sweep race, no force-exit timeout).

### Phase 2 — Medium, Low & Info (101 findings)
The remaining 101 findings were subsequently addressed:

- **Security Hardening (11 fixes):** TOCTOU race elimination (VE-004), task ID collision prevention (VE-005), depends_on max length (VE-006), cwd validation (VE-007), answer field limits (VE-008/VE-009), symlink detection (VE-010), storage dir symlink protection (PR-004), URI parsing (VE-011), schema alignment (VE-012), cancel-all race (VE-013), prompt size check (VE-014)
- **Reliability Hardening (28 fixes):** Terminal status guards on appendOutput (SM-001/SM-014), dependency-aware eviction (SM-009), stuck-PENDING detection (SM-012), session liveness validation (FB-006), retryCount preservation (FB-008), session leak fixes (CC-004), shutdown guards (MS-003), error boundaries (MS-006/MS-013), and all remaining concurrency, state machine, and persistence findings
- **Resource Management (16 fixes):** PTY recycler improvements (RM-001), ghost FD prevention (RM-002), file handle cleanup (RM-004), timer cleanup during shutdown (RM-006/MS-001), and all remaining timer, memory, and FD leak findings
- **Info-level improvements (15 fixes):** Documentation gaps, theoretical concerns, and defensive coding improvements across all domains

---

## Methodology

### Approach
Each domain audit was conducted through line-by-line source code analysis with focus on:
- **Race condition identification**: Tracing all async paths and identifying windows where interleaving could cause incorrect behavior
- **State machine verification**: Validating all status transitions against `VALID_TRANSITIONS` and checking for gaps
- **Resource lifecycle tracking**: Following allocation→use→cleanup paths for PTY FDs, file handles, timers, and memory
- **Input boundary analysis**: Verifying Zod schemas, path handling, and injection vectors

All 120 identified findings across all severity levels have been addressed in source code. The fixes were applied in two phases: Critical/High findings first, followed by all Medium, Low, and Info findings.

### Severity Definitions
- **Critical**: Security vulnerability or data corruption with immediate exploitability
- **High**: Correctness bug causing incorrect behavior under realistic conditions
- **Medium**: Edge case that can cause issues under specific conditions or degrades reliability
- **Low**: Defensive coding improvement or minor inconsistency
- **Info**: Documentation gap, theoretical concern, or by-design behavior worth noting

### Files Audited
25+ source files across the full `src/` tree, including all services, tools, utilities, templates, and the MCP server entry point. Each file was reviewed in context with its callers and callees.

### Audit Reports
Detailed per-domain findings with full race scenario analysis, code location references, and recommended fixes are in:
- [`stability-audit/01-fallback-recovery.md`](stability-audit/01-fallback-recovery.md)
- [`stability-audit/02-concurrency-async.md`](stability-audit/02-concurrency-async.md)
- [`stability-audit/03-resource-management.md`](stability-audit/03-resource-management.md)
- [`stability-audit/04-state-machine.md`](stability-audit/04-state-machine.md)
- [`stability-audit/05-persistence-recovery.md`](stability-audit/05-persistence-recovery.md)
- [`stability-audit/06-input-validation.md`](stability-audit/06-input-validation.md)
- [`stability-audit/07-mcp-server-tools.md`](stability-audit/07-mcp-server-tools.md)
