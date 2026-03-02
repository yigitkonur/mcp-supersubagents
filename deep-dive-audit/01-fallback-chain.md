# Domain 01: Fallback & Recovery Chain

## Lifecycle Flow

```
spawnCopilotTask()
    │
    ▼
getCurrentToken() ──no token──▶ shouldFallbackToClaudeCode()
    │ token found                   │ enabled    │ disabled
    ▼                               ▼            ▼
runSDKSession()              triggerClaudeFallback()  FAILED
    │                               │
    ▼                               ▼
session.send() ──▶ adapter.bind()   runClaudeCodeSession()
    │                               │
    │  ┌─── SDK EVENT LOOP ─────┐   ▼
    │  │ session.error(429/5xx) │  COMPLETED/FAILED
    │  │    → isPaused=true     │
    │  │    → rotationInProgress│
    │  │    → attemptRotation() │
    │  │       │                │
    │  │    success / exhaust   │
    │  │       │        │       │
    │  │    rebind    fallback  │
    │  │       │        │       │
    │  │    RUNNING   Claude    │
    │  │                        │
    │  │ session.idle ──▶ COMPLETED + unbind
    │  │ session.shutdown ──▶ FAILED/COMPLETED + unbind
    │  └────────────────────────┘
    │
RATE_LIMITED ──▶ exponential backoff (5m→10m→20m→40m→1h→2h, max 6)
    │
send_message ──▶ NEW task with resumeSessionId
```

## Findings

| # | Severity | File | Finding | Status |
|---|----------|------|---------|--------|
| F-1 | **CRITICAL** | send-message.ts | send_message on RATE_LIMITED races with auto-retry → duplicate tasks | **FIXED** |
| F-2 | **HIGH** | send-message.ts | send_message on Claude-fallback task tries to resume destroyed session | **FIXED** |
| F-3 | **HIGH** | sdk-session-adapter.ts | rebindWithNewSession swallows send() failure → 30-min silent stall | **FIXED** |
| F-4 | **HIGH** | send-message.ts | send_message uses old sessionId pointing to destroyed session | **FIXED** |
| F-5 | MEDIUM | sdk-session-adapter.ts | performHealthCheck defaults to auth-only (passes for rate-limited tokens) | Documented |
| F-6 | MEDIUM | account-manager.ts | Flat 60s cooldown ignores actual rate-limit duration | Documented |
| F-7 | MEDIUM | fallback-orchestrator.ts | fallbackAttempted=true set before terminal-state recheck | **FIXED** |
| F-8 | MEDIUM | session-snapshot.ts | pairsFromSessionEvents drops tool call inputs | Documented |
| F-9 | MEDIUM | session-snapshot.ts | MAX_TURNS/MAX_TOTAL_LENGTH not configurable | Documented |
| F-10 | MEDIUM | claude-code-runner.ts | Claude-side rate limits produce generic FAILED | Documented |
| F-11 | MEDIUM | task-persistence.ts | Retry callback may not be registered on restart | Documented |
| F-12 | LOW | sdk-session-adapter.ts | handleSessionError doesn't check isCompleted | — |
| F-13 | LOW | session-snapshot.ts | Original prompt >20KB truncation | — |
| F-14 | LOW | sdk-session-adapter.ts | Proactive quota rotation fire-and-forget | — |
| F-15 | LOW | sdk-spawner.ts | rotationCallbackRegistered module-level boolean | — |

## Corner Cases (20)

1. **Rate limit during session.idle** — LOW: Terminal guards catch it; unnecessary rotation attempt is benign
2. **All PATs exhausted + fallback disabled + max retries** — MEDIUM: Descriptive error but no auto-recovery
3. **send_message on Claude-fallback task** — HIGH: Now rejects with guidance (FIXED)
4. **Rotation succeeds but new session immediately 429** — MEDIUM: rotationAttempts counter works; 10 attempts before fallback
5. **Two concurrent 429s for same task** — LOW: rotationInProgress guard correct
6. **Task completes on old session after rotation** — LOW: isUnbound + unsubscribe double-guard
7. **Claude fallback timeout, then PAT recovers** — MEDIUM: No auto-recovery from Claude timeout
8. **send_message while auto-retry in progress** — CRITICAL: Now marks original FAILED first (FIXED)
9. **Server restart with RATE_LIMITED tasks** — MEDIUM: Retries now jittered (FIXED)
10. **Snapshot prompt exceeds MAX_TOTAL_LENGTH** — LOW: Original prompt preserved; recent context truncated
11. **session.getMessages() throws during handoff** — LOW: Graceful fallback to output-file snapshot
12. **fallbackAttempted set but fallback never ran** — MEDIUM: Fixed ordering (FIXED)
13. **Claude fallback hits its own rate limit** — MEDIUM: No retry path; task goes FAILED
14. **send_message on RATE_LIMITED bypasses retry queue** — CRITICAL: Now marks FAILED first (FIXED)
15. **Rapid rotation exhausts all tokens in <1min** — MEDIUM: 60s cooldown limits damage; fallback triggers
16. **rebindWithNewSession send() throws** — HIGH: Now propagates failure (FIXED)
17. **Proactive rotation fires after unbind** — LOW: isUnbound guard effective
18. **triggerClaudeFallback without cwd** — LOW: Falls back to task.cwd/process.cwd()
19. **resumeSession on destroyed session** — HIGH: Now checks session liveness (FIXED)
20. **rotateToNext resets stale failures for still-limited tokens** — MEDIUM: Re-enters cooldown immediately on failure
