# Domain 03: Resource Management

## Resource Inventory

| Resource | Lifecycle | Cleanup Path | Leak Risk |
|----------|-----------|-------------|-----------|
| CopilotClient | Created per workspace+token | stop() on recycle/shutdown | LOW — sweeper + shutdown |
| CopilotSession (PTY) | Created per task | destroySession → kill process | MEDIUM — rotation failure |
| Output file handles | Opened on first write | closeStaleHandles (60s) / finalize | LOW — stale sweep |
| Process PIDs | Registered on spawn | killTask escalation (SIGTERM→SIGKILL) | LOW — SIGKILL fallback |
| AbortControllers | Created per Claude fallback | abort() in cleanup paths | LOW — finally block |
| setTimeout/setInterval | Various timers | Cleared on shutdown | MEDIUM — see below |

## Timer Inventory

| Timer | Type | File | `.unref()`? | Shutdown cleanup? |
|-------|------|------|-------------|-------------------|
| staleHandleTimer | setInterval(60s) | output-file.ts | No | closeAllOutputHandles |
| staleSessionTimer | setInterval(60s) | sdk-client-manager.ts | No | shutdown clears |
| healthCheckInterval | setInterval(10s) | task-manager.ts | No | shutdown clears |
| cleanupInterval | setInterval(5min) | task-manager.ts | No | shutdown clears |
| resourceUpdateTimers | setTimeout(1s) per task | index.ts | Yes (.unref()) | shutdown clears |
| statusUpdateTimers | setTimeout(1s) per task | index.ts | Yes (.unref()) | **FIXED**: shutdown clears |
| persistTimeout | setTimeout(100-1000ms) | task-manager.ts | No | shutdown clears |
| rateLimitTimer | setTimeout(variable) | task-manager.ts | No | shutdown clears |
| abort timeouts | setTimeout(10s) per task | task-manager.ts | No | Cleared in finally |

## Findings

| # | Severity | File | Finding | Status |
|---|----------|------|---------|--------|
| F-1 | **HIGH** | sdk-client-manager.ts | PTY recycling silently fails when private PID API unavailable | **FIXED** |
| F-2 | MEDIUM | index.ts | statusUpdateTimers not cleared on shutdown | **FIXED** |
| F-3 | MEDIUM | sdk-client-manager.ts | destroySession fire-and-forget during rotation — PTY FD leak on failure | Documented |
| F-4 | MEDIUM | sdk-client-manager.ts | Failed session destroy (3 retries exhausted) leaves orphaned PTY | Documented |
| F-5 | MEDIUM | output-file.ts | File handles under continuous write never hit stale threshold | Documented |
| F-6 | LOW | output-file.ts | closeStaleHandles can close a handle mid-enqueueWrite | — |
| F-7 | LOW | output-file.ts | No fsync on output file appends | — |
| F-8 | LOW | task-manager.ts | staleHandleTimer and healthCheckInterval not .unref()'d | — |
| F-9 | LOW | sdk-session-adapter.ts | Session binding's toolMetrics Map not size-bounded | — |
| F-10 | INFO | output-file.ts | writeQueues drain unreachable for empty finalize | — |

## PTY FD Lifecycle

```
createSession()
  └─ CopilotClient spawns copilot CLI process (TCP mode)
       └─ CLI process spawns agent with PTY
            └─ /dev/ptmx FD opened

destroySession()
  └─ session.destroy() → PTY FD released
       └─ On failure: retry 3x with backoff
            └─ On all retries exhausted: FD leaked

recyclePtyLeakers()
  └─ lsof -p {pid} | grep ptmx → count
       └─ On lsof failure (3x): assume threshold exceeded (FIXED)
       └─ If count > 80 && sessions.size === 0: recycle client
```
