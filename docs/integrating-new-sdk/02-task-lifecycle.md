# Task State Machine and Lifecycle

This document covers the central data model every provider must produce transitions for. Understanding `TaskState` and `TaskStatus` is prerequisite to implementing any provider.

---

## 1. The TaskState Interface

Every task in the system is represented by a `TaskState` object. Here is the complete interface, grouped by category:

```typescript
// src/types.ts:245-290
export interface TaskState {
  // ── Identity ──
  id: string;
  status: TaskStatus;
  prompt: string;

  // ── Session ──
  sessionId?: string;
  session?: CopilotSession;       // Live session reference (cleared on terminal)

  // ── Output ──
  output: string[];               // In-memory output lines (max 2000)
  outputFilePath?: string;        // Path to .super-agents/{task-id}.output
  cachedStats?: { round: number; lastUserMessage?: string; totalMessages: number };

  // ── Timing ──
  startTime: string;              // ISO timestamp
  lastOutputAt?: string;
  lastHeartbeatAt?: string;
  endTime?: string;
  timeout?: number;               // ms
  timeoutAt?: string;             // ISO timestamp
  timeoutReason?: TimeoutReason;
  timeoutContext?: TimeoutContext;

  // ── Configuration ──
  cwd?: string;
  model?: string;
  isResume?: boolean;
  labels?: string[];
  mode?: AgentMode;               // 'fleet' | 'plan' | 'autopilot'
  fleetMode?: boolean;            // Whether fleet RPC was activated

  // ── Dependencies ──
  dependsOn?: string[];           // Task IDs that must complete first

  // ── Provider & Fallback ──
  provider?: Provider;            // 'copilot' | 'claude-cli'
  fallbackAttempted?: boolean;    // Single-flight guard for Claude fallback
  switchAttempted?: boolean;
  retryInfo?: RetryInfo;
  exitCode?: number;
  error?: string;

  // ── SDK Enhancement Fields ──
  failureContext?: FailureContext;
  completionMetrics?: CompletionMetrics;
  quotaInfo?: QuotaInfo;
  sessionMetrics?: SessionMetrics;
  pendingQuestion?: PendingQuestion;
}
```

## 2. TaskStatus Enum — All 8 States

```typescript
// src/types.ts:21-30
export enum TaskStatus {
  PENDING      = 'pending',       // Created, waiting to start
  WAITING      = 'waiting',       // Blocked on depends_on tasks
  RUNNING      = 'running',       // Actively executing
  COMPLETED    = 'completed',     // Finished successfully (TERMINAL)
  FAILED       = 'failed',        // Finished with error (TERMINAL)
  CANCELLED    = 'cancelled',     // User-cancelled (TERMINAL)
  RATE_LIMITED = 'rate_limited',  // Waiting for rate limit cooldown
  TIMED_OUT    = 'timed_out',     // Exceeded timeout (TERMINAL)
}
```

## 3. State Machine Diagram

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                                                         │
  ┌─────────┐      │    ┌──────────┐                                         │
  │ PENDING ├──────┼───►│ WAITING  │ (if depends_on specified)               │
  └────┬────┘      │    └────┬─────┘                                         │
       │           │         │                                               │
       │           │         ├──► PENDING (deps satisfied) ──► RUNNING       │
       │           │         ├──► FAILED (deps missing/circular/dead)        │
       │           │         ├──► CANCELLED                                  │
       │           │         └──► TIMED_OUT                                  │
       │           │                                                         │
       ├───────────┼──► RUNNING ──► COMPLETED                                │
       │           │            ├──► FAILED                                  │
       │           │            ├──► CANCELLED                               │
       │           │            ├──► TIMED_OUT                               │
       │           │            └──► RATE_LIMITED ──► RUNNING (auto-retry)   │
       │           │                              ├──► FAILED (max retries)  │
       │           │                              ├──► CANCELLED             │
       │           │                              └──► TIMED_OUT             │
       │           │                                                         │
       ├───────────┼──► CANCELLED (TERMINAL — no further transitions)        │
       ├───────────┼──► FAILED    (TERMINAL — no further transitions)        │
       └───────────┼──► TIMED_OUT (TERMINAL — no further transitions)        │
                    │                                                         │
                    │  COMPLETED  (TERMINAL — no further transitions)         │
                    └─────────────────────────────────────────────────────────┘
```

## 4. VALID_TRANSITIONS Map

This is the exact code enforcing legal transitions:

```typescript
// src/services/task-manager.ts:14-23
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  [TaskStatus.PENDING]:      new Set([TaskStatus.WAITING, TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED, TaskStatus.TIMED_OUT]),
  [TaskStatus.WAITING]:      new Set([TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED, TaskStatus.TIMED_OUT]),
  [TaskStatus.RUNNING]:      new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT, TaskStatus.RATE_LIMITED]),
  [TaskStatus.RATE_LIMITED]: new Set([TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.RUNNING, TaskStatus.TIMED_OUT]),
  [TaskStatus.COMPLETED]:    new Set([]),  // terminal
  [TaskStatus.FAILED]:       new Set([]),  // terminal
  [TaskStatus.CANCELLED]:    new Set([]),  // terminal
  [TaskStatus.TIMED_OUT]:    new Set([]),  // terminal
};
```

Illegal transitions are **logged and silently rejected** — `updateTask()` returns the current state unchanged.

## 5. Terminal vs Non-Terminal States

```typescript
// src/types.ts:320-329
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.TIMED_OUT,
]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
```

Terminal states have these effects:
- `session` reference is cleared to `undefined`
- `endTime` is set if not already present
- Output file is finalized with completion status
- No further status transitions are accepted
- Only `completionMetrics` and `sessionMetrics` updates are allowed post-terminal

## 6. Internal-to-MCP Status Mapping

The internal 8-state model is richer than what MCP clients see. The `task-status-mapper.ts` maps to 5 external states:

| Internal Status | MCP Status | Rationale |
|-----------------|------------|-----------|
| `pending` | `pending` | Direct mapping |
| `waiting` | `pending` | Client sees both as "not started yet" |
| `running` | `running` | Direct mapping |
| `completed` | `completed` | Direct mapping |
| `failed` | `failed` | Direct mapping |
| `cancelled` | `cancelled` | Direct mapping |
| `rate_limited` | `running` | Client sees this as "still working" (auto-retry) |
| `timed_out` | `failed` | Client sees this as a failure |

## 7. The In-Place Mutation Rule

**Critical:** `taskManager.updateTask()` uses `Object.assign(task, updates)` — **not** spread/replace:

```typescript
// src/services/task-manager.ts:1157
Object.assign(task, updates);
```

This preserves the object reference in the `Map` so that `appendOutput()` (which holds a direct reference via `this.tasks.get(id)`) never pushes to a stale copy.

```typescript
// CORRECT — same reference in Map
Object.assign(task, { status: TaskStatus.COMPLETED });

// WRONG — breaks appendOutput() references, causes silent data loss
this.tasks.set(id, { ...task, status: TaskStatus.COMPLETED });
```

Output arrays are trimmed with `splice(0, excess)`, not `slice(-limit)`, for the same reason.

## 8. What Your Provider Must Do

At minimum, your provider must produce these transitions:

1. **PENDING → RUNNING** — Call `taskManager.updateTask(taskId, { status: TaskStatus.RUNNING })` when execution begins
2. **RUNNING → COMPLETED** — On successful completion: `{ status: TaskStatus.COMPLETED, endTime: new Date().toISOString(), exitCode: 0 }`
3. **RUNNING → FAILED** — On error: `{ status: TaskStatus.FAILED, error: message, endTime: new Date().toISOString(), exitCode: 1 }`

Optional but recommended:
- **RUNNING → RATE_LIMITED** — If your SDK has rate limiting with retry
- Populate `sessionMetrics` for observability
- Set `session: undefined` on terminal states (automatic if using `updateTask` with terminal status)

**Important:** Always re-fetch the task from `taskManager.getTask(taskId)` after any `await` — the task may have been cancelled/completed by another code path during the yield.

---

**Previous:** [01 — System Overview](./01-system-overview.md) · **Next:** [03 — Task Manager Contract](./03-task-manager-contract.md)
