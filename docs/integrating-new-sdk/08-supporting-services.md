# Supporting Services

This document covers the ancillary singletons that every provider interacts with. You don't implement these — you use them.

---

## 1. Output File System

**File:** `src/services/output-file.ts`

### Two `.super-agents/` Locations

| Location | Contents | Purpose |
|----------|----------|---------|
| `~/.super-agents/{md5(cwd)}.json` | Task state persistence | Survives server restart |
| `{cwd}/.super-agents/{task-id}.output` | Verbose execution logs | Streamable with `tail -f` |

### Key Functions

```typescript
createOutputFile(cwd: string, taskId: string): Promise<string>  // Returns file path
appendToOutputFile(filePath: string, content: string): Promise<void>
finalizeOutputFile(filePath: string, status: TaskStatus, error?: string): Promise<void>
```

### Write Queue Serialization

Each output file has its own Promise chain to prevent concurrent writes from interleaving:

```typescript
// Per-task write queue
enqueueWrite(key: string, fn: () => Promise<void>): Promise<void>
```

This means `appendToOutputFile` calls are serialized per-task but concurrent across tasks.

### Persistent File Handles

File handles are cached via `getOrOpenHandle()` to avoid repeated open/close cycles. A cleanup sweep runs every 60 seconds, closing handles that haven't been used for 5 minutes.

### Timestamp Format

All output lines are prefixed with `[HH:MM:SS]`:

```typescript
formatTimestamp(): string  // e.g., "[14:23:07]"
```

### What Your Provider Does

Nothing special. The task manager handles output file creation in `createTask()` and writes via `appendOutput()`/`appendOutputFileOnly()`. You just call those task manager methods.

## 2. Task Persistence

**File:** `src/services/task-persistence.ts`

### Atomic Writes

```
Write to temp file → fsync → rename to target
```

This prevents corruption if the process crashes mid-write.

### Dirty-Check Hash

Before writing, the service computes an MD5 hash of the serialized state. If the hash matches the last write, the write is skipped. This reduces disk I/O for frequently-updated tasks.

### Write Coalescing

The write chain pattern limits writes to at most 2 outstanding per file path:

```typescript
// If a write is in progress and another is queued, a third request
// replaces the queued one rather than adding to the queue
```

This prevents write amplification when output streams rapidly.

### Crash Recovery

On server restart, `loadPersistedTasks()` recovers state:

| Persisted Status | Recovery Status | Rationale |
|-----------------|-----------------|-----------|
| `RUNNING` | `FAILED` | Session is gone |
| `PENDING` | `FAILED` | Cannot resume without session |
| `WAITING` (deps satisfied) | `PENDING` | Re-evaluate dependencies |
| `WAITING` (deps unsatisfied) | `WAITING` | Keep waiting |
| `RATE_LIMITED` | `RATE_LIMITED` | Preserved for auto-retry |
| `COMPLETED` | `COMPLETED` | No change |
| `FAILED` | `FAILED` | No change |

### What Your Provider Does

Nothing. Persistence is triggered automatically by `taskManager.updateTask()`.

## 3. Process Registry

**File:** `src/services/process-registry.ts` — Singleton: `processRegistry`

### `TrackedProcess` Interface

```typescript
interface TrackedProcess {
  taskId: string;
  pid?: number;              // OS process ID (for SIGTERM/SIGKILL)
  pgid?: number;             // Process group ID
  abortController?: AbortController;  // For Claude fallback
  session?: CopilotSession;           // For Copilot SDK abort
  registeredAt: number;      // Date.now()
  label?: string;            // 'copilot-session' or 'claude-fallback'
}
```

### What Your Provider Must Register

After creating your SDK session/process, register it:

```typescript
processRegistry.register({
  taskId,
  pid: extractPid(session),      // if available
  abortController: controller,   // if using AbortController
  session: sdkSession,           // if using Copilot-style session
  registeredAt: Date.now(),
  label: 'your-provider',
});
```

### Kill Escalation

When `cancel_task` is called, `processRegistry.killTask(taskId)` runs:

```
1. session.abort() with 5s timeout    (if session registered)
2. abortController.abort()            (if AbortController registered)
3. SIGTERM to PID/PGID                (if PID registered)
4. Wait 3 seconds
5. SIGKILL if still alive             (if PID registered)
```

Your provider must support at least one of: `session.abort()`, `AbortController`, or PID-based signals.

### Cleanup

On task completion, call:

```typescript
processRegistry.unregister(taskId);
```

The Copilot adapter does this in `unbind()`. The Claude runner does it after stream completion.

## 4. Question Registry

**File:** `src/services/question-registry.ts` — Singleton: `questionRegistry`

### Flow

```
Provider SDK fires ask_user
    │
    ▼
questionRegistry.register(taskId, sessionId, question, choices, allowFreeform)
    │
    ├── Stores PendingQuestion with Promise callbacks
    ├── Updates TaskState.pendingQuestion
    ├── Sends MCP resource notification
    │
    ▼
MCP client sees pending question via task resource
    │
    ▼
User calls answer_question MCP tool
    │
    ▼
questionRegistry.submitAnswer(taskId, answer)
    │
    ├── Validates answer (numeric choice / "CUSTOM: " prefix / freeform)
    ├── Resolves the Promise
    │
    ▼
Provider SDK receives answer, continues execution
```

### `PendingQuestion` Interface

```typescript
interface PendingQuestion {
  taskId: string;
  sessionId: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  askedAt: string;           // ISO timestamp
}
```

### Timeout

Questions time out after 30 minutes. On timeout:
- Task is marked `FAILED` with error "Question timed out after 30 minutes"
- The Promise is rejected
- The SDK's `onUserInputRequest` handler receives the rejection

### What Your Provider Does

If your SDK supports user input (ask_user), wire a handler that:

```typescript
async function handleUserInput(question: string, choices?: string[]): Promise<string> {
  const response = await questionRegistry.register(
    taskId,
    sessionId,
    question,
    choices,
    true  // allowFreeform
  );
  return response.answer;
}
```

If your SDK doesn't support user input, skip this — the registry is optional.

## 5. Tool Output Summarizer

**File:** `src/utils/tool-summarizer.ts`

### Purpose

Replaces verbose tool output lines like `[tool] Completed: Read (2214ms)` with informative summaries like `[tool] read …/sdk-session-adapter.ts:195-255 (2.2s)`.

### Key Functions

```typescript
// Extract context from tool arguments (file path, command, pattern, etc.)
extractToolContext(toolName: string, rawArgs: unknown): ToolCallContext

// Extract result info (exit code, match count, etc.)
extractResultInfo(toolName: string, rawResult: unknown): Partial<ToolResultInfo>

// Format a compact start line
formatToolStart(ctx: ToolCallContext): string

// Format a compact completion line
formatToolComplete(ctx: ToolCallContext, info: ToolResultInfo): string
```

### Integration Points

**Copilot provider** uses these in:
- `handleToolStart()` — calls `extractToolContext()` + `formatToolStart()`
- `handleToolComplete()` — calls `extractResultInfo()` + `formatToolComplete()`

**Claude provider** uses these in:
- `tool-call` part handler — calls `extractToolContext()`
- `tool-result` part handler — calls `extractResultInfo()` + `formatToolComplete()`

**Your provider** should follow the same pattern for consistent output formatting across providers.

---

**Previous:** [07 — Fallback and Rotation](./07-fallback-and-rotation.md) · **Next:** [09 — Session Metrics and Observability](./09-session-metrics-and-observability.md)
