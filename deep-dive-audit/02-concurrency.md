# Domain 02: Concurrency & Async Correctness

## Race Condition Guard Map

| Guard Flag | File | Protects Against | Acquire | Release |
|-----------|------|-------------------|---------|---------|
| `isPaused` | sdk-session-adapter.ts | Event processing during rotation | Before rotation attempt | After rebind/failure |
| `isUnbound` | sdk-session-adapter.ts | Events on destroyed bindings | Before async destroy | Never (permanent) |
| `rotationInProgress` | sdk-session-adapter.ts | Concurrent rotation attempts | Before rotation | After rebind/failure |
| `isCompleted` | sdk-session-adapter.ts | Post-completion mutations | On session.idle/completion | Never (permanent) |
| `isProcessingRateLimits` | task-manager.ts | Re-entrant rate limit processing | Before processing | In finally block |
| `isClearing` | task-manager.ts | Concurrent clearAllTasks | Before clearing | In finally block |
| `isShuttingDown` | task-manager.ts | Operations during shutdown | On shutdown | Never (permanent) |
| `timingOutTasks` Set | task-manager.ts | Double-timeout of same task | Before timeout attempt | After timeout completes |
| `resumeInProgress` Set | send-message.ts | Concurrent send_message on same task | Before spawn | In finally block |
| `retryInFlight` Set | task-manager.ts | Concurrent retry of same task | Before retry | After retry |

## Findings

| # | Severity | File | Finding | Status |
|---|----------|------|---------|--------|
| F-1 | MEDIUM | sdk-session-adapter.ts | Proactive rotation drops events via isPaused while task is completing | Documented |
| F-2 | MEDIUM | sdk-session-adapter.ts | unbind clears bindings Map while in-flight handleEvent may hold reference | Documented |
| F-3 | MEDIUM | send-message.ts / task-manager.ts | Manual send_message and auto-retry double-spawn | **FIXED** (see 01-fallback-chain F-1) |
| F-4 | LOW | sdk-client-manager.ts | pendingClients dedup only per key, not globally | — |
| F-5 | LOW | task-manager.ts | processWaitingTasks via queueMicrotask can batch multiple calls | — |
| F-6 | LOW | sdk-session-adapter.ts | Queued microtask events may slip through between isUnbound=true and unsubscribe() | — |

## Corner Cases (12)

1. **Two 429s in rapid succession** — rotationInProgress guard catches second; safe
2. **unbind() called during active rotation** — isPaused and rotationInProgress cleared; rotation callback finds isUnbound and aborts
3. **processWaitingTasks re-entrancy** — Now uses queueMicrotask for ALL terminal statuses (FIXED)
4. **Health check vs normal completion race** — timingOutTasks Set + terminal-state re-check prevents double update
5. **Client pool getClient() during shutdown** — isShuttingDown check returns immediately
6. **PTY recycle during active session** — sessions.size check prevents recycling clients with active work
7. **sweepStaleSessions vs normal completion** — Session destroyed by sweep, then adapter gets session.shutdown → isUnbound guard
8. **Two updateTask calls on same task** — Node.js single-thread prevents true interleaving; transition check is atomic with mutation
9. **Concurrent appendOutput and terminal updateTask** — appendOutput now checks isTerminalStatus (FIXED)
10. **Manual retry via send_message + auto-retry timer fire simultaneously** — Now prevented (FIXED)
11. **markTimedOut double-unbind from timeout handler and finally block** — isUnbound guard makes second unbind a no-op
12. **Claude fallback releaseFallbackSlot not called on crash** — finally block in streaming loop guarantees release

## Key Insight

The codebase's concurrency model relies on Node.js single-threaded execution with boolean guards for async re-entrancy prevention. This is correct for the use case — true concurrent mutation is impossible within a single event loop tick. The remaining risks are all async interleaving between `await` points, which the guard flags handle well.
