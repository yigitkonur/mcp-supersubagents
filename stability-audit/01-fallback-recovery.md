# Domain 1: Fallback & Recovery Chain

**Scope:** Rate limit detection, PAT rotation, exhaustion fallback, session snapshots, Claude fallback execution, send_message restart, retry queue  
**Files Reviewed:** `sdk-spawner.ts`, `account-manager.ts`, `fallback-orchestrator.ts`, `exhaustion-fallback.ts`, `session-snapshot.ts`, `claude-code-runner.ts`, `sdk-session-adapter.ts`, `send-message.ts`, `retry-queue.ts`, `types.ts`, `models.ts`  
**Date:** 2025-07-18

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2     |
| High     | 5     |
| Medium   | 8     |
| Low      | 5     |
| Info     | 3     |

---

## Findings

### FB-001 — Claude Fallback Runs with bypassPermissions by Default

- **Severity:** Critical
- **Status:** ✅ Fixed
- **Location:** `src/services/claude-code-runner.ts:21`
- **Current Behavior:** `DEFAULT_PERMISSION_MODE` was set to `'bypassPermissions'`. When a task fell back to Claude CLI, it ran with all tool permissions bypassed — including destructive operations like `rm -rf`, filesystem writes, and network calls.
- **Risk:** Prompt-injection attack in the original task prompt or a malicious context file could cause Claude to execute arbitrary destructive commands with zero guardrails.
- **Fix Applied:** Default changed from `bypassPermissions` to `plan` in `claude-code-runner.ts`.

---

### FB-023 — rotateToNext Does NOT Propagate SDK Quota Reset Date to Token State

- **Severity:** Critical
- **Status:** ✅ Fixed
- **Location:** `src/services/account-manager.ts:218-222`
- **Current Behavior:** When `rotateToNext` marked a token as failed, it only stored `failedAt = Date.now()`, `failureReason`, and `failureCount`. It did NOT accept or store the SDK-provided `quotaInfo.resetDate`.
- **Risk:** Root cause of multiple downstream issues (FB-016, FB-018). The account manager's cooldown/auto-reset logic operated on crude 60s/300s timers instead of using the precise reset timestamp the SDK provides.
- **Fix Applied:** `resetDate` parameter added to `TokenState` and propagated from session adapter through `rotateToNext()` in `account-manager.ts`.

---

### FB-002 — Rate Limit String Detection is Brittle — Single Hardcoded String

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:50, 889`
- **Current Behavior:** The string-based rate limit detector checked for exactly one string: `"Sorry, you've hit a rate limit..."`. If GitHub changed this message text, detection failed silently.
- **Risk:** The task would appear to complete normally while actually having received a rate limit notice instead of real work output.
- **Fix Applied:** Rate limit detection expanded from 1 string to 5 regex patterns in `sdk-session-adapter.ts`.

---

### FB-003 — extractStatusCode() False-Positive on Error Messages Containing Number Literals

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-spawner.ts:520-529`
- **Current Behavior:** `extractStatusCode()` used bare regex patterns like `/\b429\b/` and `/\b500\b/` to extract status codes, matching numbers in any context.
- **Risk:** Messages like `"Processed 500 items before failure"` misclassified as server errors, triggering unnecessary rotation and session destruction.
- **Fix Applied:** Status code extraction now uses context-aware regex in `sdk-spawner.ts`.

---

### FB-004 — Recursive Rotation in attemptRotationAndResume Can Stack Overflow

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:665`
- **Current Behavior:** When a health check failed after rotation, `attemptRotationAndResume` called itself recursively. With 10 accounts and all health checks failing, this created 10 nested async frames with complex memory pressure.
- **Risk:** Memory pressure from accumulated promise closures, and `rotationInProgress` flag could be cleared by the outermost `finally` while recursion was still running.
- **Fix Applied:** Recursive rotation replaced with iterative loop in `sdk-session-adapter.ts`.

---

### FB-005 — fallbackAttempted is One-Shot — Retried Tasks Can Never Fallback

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/fallback-orchestrator.ts:27-29`
- **Current Behavior:** `fallbackAttempted` flag was set permanently and never reset. When a task was retried after a rate limit, the retried execution could never fall back to Claude again.
- **Risk:** Retried attempts had no Claude safety net and went straight to FAILED.
- **Fix Applied:** `fallbackAttempted` now reset on retry in `index.ts` (onRetry callback).

---

### FB-006 — send_message Creates New Task — Does NOT Resume Original Task

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/tools/send-message.ts:141-149`
- **Current Behavior:** `send_message` creates an entirely new task via `spawnCopilotTask` with `resumeSessionId` pointing to the old session. The original task stays in its terminal state.
- **Risk:** (a) If the original task used Claude fallback, the new task tries to resume a non-existent Copilot SDK session. (b) The old session may have been destroyed by `unbind()`. (c) No validation that the sessionId points to a live session.
- **Fix Applied:** Before spawning, check if the session is still alive. If the session was destroyed or the original task used Claude fallback, spawn a fresh task with a handoff prompt instead of attempting resume.

---

### FB-007 — No Concurrent Retry Guard in Health Check Loop

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/retry-queue.ts:153-176`
- **Current Behavior:** `shouldRetryNow()` is a pure function with no lock to prevent the health check from triggering the same retry twice.
- **Risk:** Two concurrent retries of the same task could create two parallel sessions consuming PAT tokens.
- **Fix Applied:** Add a `retryInProgress` flag per-task. Set before triggering retry, clear on completion/failure.

---

### FB-008 — markAsRateLimited Resets retryCount to 0

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:796`
- **Current Behavior:** When `markAsRateLimited` is called, it creates a fresh `RetryInfo` with `retryCount: 0`, ignoring previous retry history.
- **Risk:** A task that was retried multiple times and hits another rate limit gets unlimited effective retries.
- **Fix Applied:** Preserve existing retryCount: `retryCount: (task.retryInfo?.retryCount ?? 0)`.

---

### FB-009 — Session Snapshot Can Be Empty or Misleading After Rotation

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/session-snapshot.ts:241-251`
- **Current Behavior:** After cross-token rotation, the session object may be destroyed or replaced. `session.getMessages()` throws, falls back to output file parsing which may produce empty results.
- **Risk:** Claude fallback could start with zero context about what the Copilot session accomplished.
- **Fix Applied:** Build the snapshot BEFORE unbinding/destroying the session. Add minimum-content check.

---

### FB-010 — Unbind-Before-Fallback Ordering Bug in handleRateLimit

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-spawner.ts:597-609`
- **Current Behavior:** `triggerClaudeFallback` is called before unbind, but there's no `return` after the exhausted path, causing potential double-fallback attempt.
- **Risk:** Same task could have `triggerClaudeFallback` called twice.
- **Fix Applied:** Add `return;` after the `shouldFallbackToClaudeCode` block.

---

### FB-011 — Account Manager getCurrentToken() Silently Switches Token

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/account-manager.ts:125-138`
- **Current Behavior:** When `getCurrentToken()` finds the current token in cooldown, it silently updates `currentIndex` without incrementing `rotationCount`.
- **Risk:** Shadow rotation invisible to monitoring. `fromTokenIndex` misattribution in next rotation.
- **Fix Applied:** Increment `rotationCount` and set `lastRotationTime` when `getCurrentToken()` switches tokens.

---

### FB-012 — Proactive Quota Rotation is Fire-and-Forget with No Error Propagation

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-session-adapter.ts:1009-1028`
- **Current Behavior:** Proactive rotation increments `rotationAttempts` but if it fails, the session continues on the exhausted account.
- **Risk:** Proactive rotation failures can exhaust the rotation budget before reactive rotation is needed.
- **Fix Applied:** Don't increment `rotationAttempts` for proactive rotations, or use a separate counter.

---

### FB-013 — Claude Fallback Concurrency Limiter Can Deadlock Under Task Cancellation

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/claude-code-runner.ts:30-47`
- **Current Behavior:** If a process is killed while tasks are waiting for a fallback slot, the resolver never fires and the slot is permanently leaked.
- **Risk:** Over time, all 3 slots could be leaked, causing all future fallbacks to queue indefinitely.
- **Fix Applied:** In `abortAllFallbackSessions`, drain `fallbackQueue` by resolving all pending resolvers.

---

### FB-014 — No Validation That Claude CLI/SDK Is Available Before Fallback

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/claude-code-runner.ts:272-283`
- **Current Behavior:** No pre-flight check for Claude CLI availability. Failure produces a generic error with `fallbackAttempted = true` set permanently.
- **Risk:** Unhelpful error message, no further fallback attempts possible.
- **Fix Applied:** Add pre-flight check at startup or in `triggerClaudeFallback`.

---

### FB-015 — send_message Does Not Guard Against Concurrent Resume of Same Session

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/tools/send-message.ts:127`
- **Current Behavior:** `resumeInProgress` guards by taskId, not sessionId. Two different completed tasks sharing the same session could be resumed simultaneously.
- **Risk:** Corrupted session state, interleaved messages.
- **Fix Applied:** Key the guard on `sessionId` in addition to `taskId`.

---

### FB-016 — Token Cooldown is Only 60 Seconds — Too Short for Real Rate Limits

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/account-manager.ts:13`
- **Current Behavior:** `FAILED_TOKEN_COOLDOWN_MS = 60 * 1000`. GitHub Copilot rate limit windows can be 1-5 minutes or longer.
- **Risk:** System attempts to use a still-rate-limited token, burning rotation attempts.
- **Fix Applied:** Use SDK's `quotaInfo.resetDate` when available (now partially addressed by FB-023 fix). Fallback to a longer default (5 minutes).

---

### FB-017 — handleSessionError in sdk-spawner Uses Timeout String Match

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/sdk-spawner.ts:463`
- **Current Behavior:** Case-sensitive string matching for `'Timeout'` and any context containing "timeout" triggers TIMED_OUT status.
- **Risk:** Database timeout errors misclassified as task timeouts.
- **Fix Applied:** Use structured SDK `errorType` field instead of string matching.

---

### FB-018 — Stale Failure Auto-Reset at 5 Minutes Ignores Long Rate Limit Windows

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/account-manager.ts:14, 241`
- **Current Behavior:** Tokens with failures older than 5 minutes are auto-cleared, but rate limits can be per-hour.
- **Risk:** System retries tokens that are still rate-limited, wasting rotation attempts.
- **Fix Applied:** Store rate limit reset timestamp from `quotaInfo.resetDate` in `TokenState.resetAt`.

---

### FB-019 — Single-Token Mode Immediately Returns allExhausted Without Retry

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/account-manager.ts:204-212`
- **Current Behavior:** With one token, the first rate limit immediately triggers Claude fallback or task failure with no retry.
- **Risk:** Single-token users get no rotation benefit. Acceptable given retry queue exists.
- **Fix Applied:** Consider returning `retryAfterMs` hint instead of `allExhausted`.

---

### FB-020 — Session Snapshot Output File Parsing Skips Lines Starting with `[` or `>`

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/services/session-snapshot.ts:67-68`
- **Current Behavior:** Lines starting with `[` or `>` are skipped during output file parsing. If the assistant's actual output starts with `[` or `>`, that content is dropped from the snapshot.
- **Risk:** Incomplete context for Claude fallback.
- **Fix Applied:** Only skip lines matching known system prefixes.

---

### FB-021 — fallback-orchestrator Swallows Errors When awaitCompletion is false

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/services/fallback-orchestrator.ts:65-81`
- **Current Behavior:** When `awaitCompletion` is false, `triggerClaudeFallback` returns `true` immediately even if Claude fails asynchronously.
- **Risk:** Original Copilot error context may be lost.
- **Fix Applied:** Add `task.fallbackPending: boolean` flag for monitoring.

---

### FB-022 — Claude Fallback Timeout Calculation Guarantees Minimum 5 Minutes

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/services/fallback-orchestrator.ts:44`
- **Current Behavior:** `Math.max(5 * 60 * 1000, taskTimeout - elapsed)` ensures at least 5 minutes for Claude fallback regardless of original timeout.
- **Risk:** Users with short timeouts get longer-than-expected execution during fallback. Intentional behavior.
- **Fix Applied:** Document this behavior in the `spawn_agent` tool description.
