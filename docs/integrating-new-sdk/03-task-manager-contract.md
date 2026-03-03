# Task Manager: The Central Singleton

This document specifies the public API every provider interacts with. The task manager is the single source of truth for all task state.

---

## 1. Singleton Import Pattern

```typescript
import { taskManager } from './task-manager.js';
```

The `taskManager` is instantiated once at module scope. Every service imports this same instance. There is no dependency injection — the singleton is the contract.

## 2. `createTask()`

```typescript
createTask(
  prompt: string,
  cwd?: string,
  model?: string,
  options?: {
    isResume?: boolean;
    retryInfo?: RetryInfo;
    dependsOn?: string[];
    labels?: string[];
    provider?: Provider;
    fallbackAttempted?: boolean;
    switchAttempted?: boolean;
    timeout?: number;
    mode?: AgentMode;
  }
): TaskState
```

**Behavior:**
- Generates a unique task ID via `generateUniqueTaskId()`
- Initial status is `PENDING` unless `dependsOn` is specified with unsatisfied deps → `WAITING`
- Creates the output file eagerly (`createOutputFile(cwd, id)` — async, fire-and-forget)
- Validates dependencies (rejects circular, duplicate, self-referencing, missing)
- Throws if task capacity is reached (MAX_TASKS=100, evicts terminal tasks first)
- Fires `taskCreatedCallback` synchronously
- Schedules persistence (debounced)

**Your provider receives the returned `TaskState` object.** The `id` field is what you use for all subsequent operations.

## 3. `updateTask()`

```typescript
updateTask(
  id: string,
  updates: Partial<TaskState>,
  options?: { persist?: boolean }
): TaskState | null
```

**Semantics:**
- Uses `Object.assign(task, updates)` — in-place mutation, not replacement
- Validates state transitions via `VALID_TRANSITIONS` map before applying
- Illegal transitions are **logged and silently rejected** — returns current task unchanged
- Terminal status changes trigger immediate persistence (not debounced)
- `RUNNING` ← `PENDING` also triggers immediate persistence
- On terminal status: clears `session`, sets `endTime`, finalizes output file
- On `COMPLETED`: triggers `processWaitingTasks()` via `queueMicrotask`
- On `FAILED`/`CANCELLED`/`TIMED_OUT`: cascades to waiting dependents via `queueMicrotask`
- Post-terminal updates are silently rejected **except** `completionMetrics` and `sessionMetrics`

**Returns** the updated task, or `null` if task not found.

## 4. `appendOutput()` vs `appendOutputFileOnly()`

| Method | In-Memory Array | Output File | Callbacks | Use For |
|--------|:---------------:|:-----------:|:---------:|---------|
| `appendOutput(id, line)` | ✅ | ✅ | ✅ `outputCallback` | Tool completions, assistant messages, status changes, summaries |
| `appendOutputFileOnly(id, line)` | ❌ | ✅ | ❌ | Reasoning content, session metadata, per-turn usage, verbose debug |

**Output routing convention:**

| Prefix | Method | Rationale |
|--------|--------|-----------|
| `[tool]` | `appendOutput` | Tool execution visible to caller |
| `[error]` | `appendOutput` | Errors visible to caller |
| `[rotation]` | `appendOutput` | Account rotation visible to caller |
| `[rate-limit]` | `appendOutput` | Rate limit info visible to caller |
| `[subagent]` | `appendOutput` | Sub-agent lifecycle visible to caller |
| `[summary]` | `appendOutput` | Session summary visible to caller |
| `[metrics]` | `appendOutput` | Completion metrics visible to caller |
| `--- Turn N ---` | `appendOutput` | Turn boundaries visible to caller |
| `[reasoning]` | `appendOutputFileOnly` | Verbose, saves tokens for caller |
| `[usage]` | `appendOutputFileOnly` | Per-turn usage, cumulative summary at end |
| `[quota]` | `appendOutputFileOnly` | Available via `quotaInfo` in MCP resource |
| `[session]` | `appendOutputFileOnly` | Internal session metadata |
| `[assistant] Message complete` | `appendOutputFileOnly` | Message UUID noise |
| `[assistant] Turn ended` | `appendOutputFileOnly` | Turn started is sufficient |

**`appendOutput` side effects:**
- Updates `lastOutputAt` and `lastHeartbeatAt` timestamps
- Clears stall warnings (`timeoutReason = 'stall'`)
- Trims array to MAX_OUTPUT_LINES (2000) via `splice(0, excess)`
- Updates `cachedStats` incrementally (turn count, message count)
- Writes to output file asynchronously
- Schedules persistence (output debounce = 1s)

## 5. `getTask()`

```typescript
getTask(id: string): TaskState | null
```

Returns the task by ID, or `null` if not found. IDs are normalized (case-insensitive prefix matching).

**Critical pattern — re-fetch after await:**

```typescript
// Start an async operation
await someAsyncWork();

// Task may have been cancelled/completed during the await
const task = taskManager.getTask(taskId);
if (!task || isTerminalStatus(task.status)) {
  return; // Don't continue — task is done
}

// Safe to proceed
taskManager.updateTask(taskId, { ... });
```

This pattern appears throughout both existing providers and must be followed by new providers.

## 6. Callback System

The task manager exposes callbacks for cross-cutting concerns:

```typescript
// Called when a WAITING task's deps are satisfied and it should execute
onExecute(callback: (task: TaskState) => Promise<void>): () => void

// Called when a RATE_LIMITED task should be retried
onRetry(callback: (task: TaskState) => Promise<string | undefined>): () => void

// Called on any output line
onOutput(callback: (taskId: string, line: string) => void): () => void

// Called on any status change
onStatusChange(callback: (task: TaskState, previousStatus: TaskStatus) => void): () => void

// Called when a new task is created
onTaskCreated(callback: (task: TaskState) => void): () => void

// Called when a task is deleted
onTaskDeleted(callback: (taskId: string) => void): () => void
```

Each returns an unsubscribe function. The `onExecute` callback is wired by the SDK spawner to `executeWaitingTask()`. The `onRetry` callback handles auto-retry of rate-limited tasks.

## 7. Dependency Resolution

```typescript
// Validate dependencies before creating a task
validateDependencies(dependsOn: string[], newTaskId?: string): string | null

// Check dependency status for an existing task
getDependencyStatus(taskId: string): { satisfied: boolean; missing: string[]; failed: string[]; pending: string[] } | null

// Force-start a WAITING task, bypassing dependencies
forceStartTask(taskId: string): Promise<{ success: boolean; ... }>
```

The private `processWaitingTasks()` method runs whenever:
- A task reaches `COMPLETED` (via `queueMicrotask`)
- A task reaches `FAILED`/`CANCELLED`/`TIMED_OUT` (cascades failures)
- `onExecute` callback is registered
- Server starts and loads persisted tasks

Circular dependencies are detected via DFS traversal (`findCircularDependencyPath`).

## 8. Task Capacity and Eviction

- **MAX_TASKS = 100** — If the map is full, `createTask()` first runs `cleanup()` to evict expired terminal tasks (TTL = 1 hour). If still full, throws.
- **TTL cleanup** — Every 5 minutes, terminal tasks older than `TASK_TTL_MS` (1 hour) are removed. Tasks referenced as dependencies by non-terminal tasks are protected from eviction.
- **Output trimming** — `appendOutput` trims to 2000 lines via `splice(0, excess)`.

## 9. What Your Provider Must Call

**Minimum API surface:**

```typescript
// 1. Create the task (usually done in the spawner, not the runner)
const task = taskManager.createTask(prompt, cwd, model, { provider: 'your-provider', ... });

// 2. Mark as running when execution starts
taskManager.updateTask(taskId, { status: TaskStatus.RUNNING, sessionId: '...' });

// 3. Stream output
taskManager.appendOutput(taskId, '[tool] doing something...');
taskManager.appendOutputFileOnly(taskId, '[reasoning] thinking...');

// 4. Mark terminal state
taskManager.updateTask(taskId, {
  status: TaskStatus.COMPLETED,  // or FAILED
  endTime: new Date().toISOString(),
  exitCode: 0,                   // or 1 for failure
  error: undefined,              // or error message for failure
  session: undefined,            // always clear on terminal
});
```

---

**Previous:** [02 — Task Lifecycle](./02-task-lifecycle.md) · **Next:** [04 — Spawn Pipeline](./04-spawn-pipeline.md)
