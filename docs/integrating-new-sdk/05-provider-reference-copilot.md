# Reference: The Copilot SDK Provider

This document is a full walkthrough of the primary event-based provider. Study this as the canonical reference for how a provider integrates with the task system.

---

## 1. Overview: Three-File Architecture

The Copilot provider spans three files, each with a distinct responsibility:

| File | Singleton | Responsibility |
|------|-----------|----------------|
| `src/services/sdk-spawner.ts` | (functions) | Entry point — creates tasks, dispatches to SDK sessions |
| `src/services/sdk-client-manager.ts` | `sdkClientManager` | SDK client pooling, session lifecycle, token rotation |
| `src/services/sdk-session-adapter.ts` | `sdkSessionAdapter` | Event→TaskState mapping, rotation protocol, metrics |

## 2. SDK Client Manager

### Client Creation and Pooling

The `SDKClientManager` manages `CopilotClient` instances keyed by `{cwd}:{tokenIndex}`. When a session is needed, `getClient(cwd)` returns or creates a client for the current token:

```typescript
// sdk-client-manager.ts:256
async getClient(cwd: string): Promise<CopilotClient>
```

- Uses `accountManager.getCurrentToken()` for authentication
- Deduplicates concurrent creation via `pendingClients` Map
- TCP mode (`useStdio: false`) to avoid macOS stdio pipe race conditions
- Auto-restart disabled; crashed clients are detected by health checks

### Session Creation

```typescript
// sdk-client-manager.ts:340
async createSession(
  cwd: string,
  sessionId: string,
  config: Omit<SessionConfig, 'sessionId' | 'onPermissionRequest'>,
  taskId?: string
): Promise<CopilotSession>
```

The session config includes:
- **Permission handler**: `approveAll` (SDK-exported) for default mode, or custom safe-mode handler
- **User input handler**: Forwards `ask_user` requests to `questionRegistry`
- **Session hooks**: Lifecycle telemetry wired via `createSessionHooks(taskId)`

### Token Tracking

Session→token association is tracked via `ClientEntry.tokenIndex`. This enables `getSessionTokenIndex(sessionId)` to report which token a session is using — critical for rotation (avoids thundering-herd misattribution).

## 3. SDK Spawner

### `spawnCopilotTask()`

The main entry point for the Copilot provider:

```typescript
// sdk-spawner.ts:176
export async function spawnCopilotTask(options: SpawnOptions): Promise<string>
```

**Flow:**

1. **Register rotation callback** — One-time setup via `ensureRotationCallbackRegistered()`
2. **Resolve CWD** — Validates against workspace root (security: prevents CWD escape)
3. **Resolve model** — Via `resolveModel(options.model, options.taskType)`
4. **Create task** — `taskManager.createTask()` with status `PENDING` or `WAITING`
5. **Check tokens** — If no PAT token available, trigger immediate Claude fallback
6. **`setImmediate`** — Returns task ID immediately, runs session async

```typescript
// sdk-spawner.ts:259-290
setImmediate(() => {
  const current = taskManager.getTask(taskId);
  if (!current || isTerminalStatus(current.status)) return;

  runSDKSession(taskId, prompt, cwd, model, options).catch((err) => {
    // ... error handling with fallback
  });
});

return taskId;  // Returned immediately to MCP client
```

The `setImmediate` pattern is essential — without it, the MCP tool call would block until the entire session completes, causing client timeouts.

### `runSDKSession()`

The internal session runner:

```typescript
// sdk-spawner.ts:362
async function runSDKSession(
  taskId: string, prompt: string, cwd: string, model: string, options: SpawnOptions
): Promise<void>
```

1. Verify task is still `PENDING`
2. Set timeout info
3. Build `SessionConfig` (model, streaming, working directory, infinite sessions)
4. Create session via `sdkClientManager.createSession()`
5. Register with `processRegistry`
6. Bind to session adapter: `sdkSessionAdapter.bind(taskId, session, prompt)`
7. Set autopilot mode: `session.rpc.mode.set({ mode: 'autopilot' })`
8. If fleet mode: `session.rpc.fleet.start({})`
9. Append mode suffix prompt
10. Send prompt: `session.send({ prompt: finalPrompt })`

### `session.send()` not `sendAndWait()`

Fire-and-forget is deliberate. Using `sendAndWait()` causes a double-completion race where both `sendAndWait`'s internal idle handler and the adapter's `session.idle` handler compete to mark the task `COMPLETED`.

## 4. SDK Session Adapter

### `SessionBinding` — Per-Task State

```typescript
// sdk-session-adapter.ts:106-147
interface SessionBinding {
  taskId: string;
  session: CopilotSession;
  sessionId: string;
  unsubscribe: () => void;
  outputBuffer: string[];           // Streaming text accumulator
  reasoningBuffer: string[];        // Reasoning content accumulator
  lastMessageId?: string;
  startTime: Date;
  isCompleted: boolean;
  isPaused: boolean;                // Set during rotation
  error?: string;
  rotationAttempts: number;
  maxRotationAttempts: number;      // 10
  rotationInProgress: boolean;      // RC-1 guard
  errorHandlingInProgress: boolean; // CC-017 guard
  proactiveRotationAttempted?: boolean;
  rateLimitInfo?: { ... };
  pendingPrompt?: string;           // Original prompt for rotation handoff
  // Metrics
  turnCount: number;
  totalTokens: { input: number; output: number };
  toolMetrics: Map<string, ToolMetrics>;
  toolStartTimes: Map<string, number>;
  toolCallIdToName: Map<string, string>;
  toolCallContexts: Map<string, ToolCallContext>;
  activeSubagents: Map<string, SubagentInfo>;
  completedSubagents: SubagentInfo[];
  quotas: Map<string, QuotaInfo>;
  lastMetricsUpdateAt: number;
  isUnbound: boolean;               // Idempotent cleanup guard
  subagentTools: Map<string, string[]>;
}
```

### `bind()` and Event Subscription

```typescript
// sdk-session-adapter.ts:205
bind(taskId: string, session: CopilotSession, pendingPrompt?: string): void
```

1. Cleans up any existing binding for the task
2. Creates fresh `SessionBinding` with zeroed metrics
3. Sets up event serialization (CC-017):

```typescript
let eventChain: Promise<void> = Promise.resolve();

const unsubscribe = session.on((event: SessionEvent) => {
  eventChain = eventChain.then(() =>
    this.handleEvent(taskId, event, binding)
  ).catch((err) => { ... });
});
```

4. Updates task to `RUNNING` with initial `sessionMetrics`

### CC-017: Event Serialization

Without serialization, `handleSessionError` can yield at an `await` (e.g., `triggerClaudeFallback`) and `handleSessionIdle` runs during that yield, marking the task `COMPLETED` before the error handler finishes. The Promise chain ensures events are processed strictly in order.

### Event Handler Table

| Event Type | Handler | TaskState Effect |
|------------|---------|------------------|
| `session.start` | `handleSessionStart` | Output file only: session ID, model, CWD |
| `session.resume` | inline | Clear pause state |
| `session.idle` | `handleSessionIdle` | → `COMPLETED` (unless rotation/error in progress) |
| `session.error` | `handleSessionError` | → rotation attempt, or → `RATE_LIMITED`/`FAILED` |
| `session.shutdown` | `handleSessionShutdown` | Extract `CompletionMetrics`, → `COMPLETED` or `FAILED` |
| `session.compaction_start` | inline | Output: "compaction started" |
| `session.compaction_complete` | inline | Output: compaction result |
| `session.mode_changed` | inline | Output file only: mode change |
| `session.model_change` | inline | Output file only: model change |
| `assistant.turn_start` | `handleTurnStart` | Increment `turnCount`, output turn marker |
| `assistant.message_delta` | `handleMessageDelta` | Buffer text, flush at 500 lines |
| `assistant.message` | `handleAssistantMessage` | Flush buffer, string-based rate limit check |
| `assistant.reasoning` | inline | Flush reasoning to file only |
| `assistant.reasoning_delta` | inline | Buffer reasoning, flush at 200 lines |
| `assistant.turn_end` | inline | Flush all buffers |
| `assistant.usage` | `handleUsage` | Update tokens, quota tracking, proactive rotation |
| `tool.execution_start` | `handleToolStart` | Track start time, extract context, file-only output |
| `tool.execution_progress` | inline | Output progress message |
| `tool.execution_complete` | `handleToolComplete` | Compute duration, format summary, in-memory output |
| `subagent.selected` | `handleSubagentSelected` | Store tools list for started event |
| `subagent.started` | `handleSubagentStarted` | Track in `activeSubagents`, output with description |
| `subagent.completed` | `handleSubagentCompleted` | Move to `completedSubagents`, output with duration |
| `subagent.failed` | `handleSubagentFailed` | Move to `completedSubagents` with error |
| `abort` | `handleAbort` | → `CANCELLED` |
| `user.message` | inline | Output file only |

### Rate Limit Detection

Two detection mechanisms:

1. **Structured** — `session.error` event with `statusCode` in `ROTATABLE_STATUS_CODES` (429, 500, 502, 503, 504)
2. **String-based fallback** — `assistant.message` content matching patterns like `/rate limit/i`, `/too many requests/i`, `/quota exceeded/i`

Both paths trigger `attemptRotationAndResume()`.

### Rotation Protocol

```typescript
// sdk-session-adapter.ts:641
private async attemptRotationAndResume(
  taskId: string, binding: SessionBinding, statusCode: number, errorMessage: string
): Promise<boolean>
```

Iterative loop (not recursive — prevents stack overflow with many accounts):

1. Try registered rotation callback (from sdk-spawner)
2. If callback fails, try `sdkClientManager.rotateOnError()` directly
3. Health check the new account
4. If all accounts exhausted → `triggerClaudeFallback()`
5. If rotation succeeds → `rebindWithNewSession()`

### `rebindWithNewSession()`

```typescript
// sdk-session-adapter.ts:817
private async rebindWithNewSession(
  taskId: string, oldBinding: SessionBinding, newSession: CopilotSession
): Promise<boolean>
```

1. Unsubscribe old session events, destroy old session
2. Create new `SessionBinding` preserving: turn count, token totals, tool metrics, subagent info, rotation attempts
3. Set up fresh event serialization chain
4. Update task with new session reference
5. Re-apply autopilot mode + fleet mode on new session
6. Send handoff prompt (original task prompt with rate-limit context note)

### `unbind()` and Memory Cleanup

```typescript
// sdk-session-adapter.ts:1604
unbind(taskId: string): void
```

1. Check `isUnbound` guard (idempotent — safe to call multiple times)
2. Set `isUnbound = true`
3. Unsubscribe from events
4. Clear all Maps and arrays (toolMetrics, toolStartTimes, subagentTools, etc.)
5. Destroy session via `sdkClientManager.destroySession()`
6. Remove from bindings Map
7. Unregister from `processRegistry`

## 5. Token Rotation Timeline

```
Time ──────────────────────────────────────────────────────►

Task created (Token A)
    │
    ▼
session.send(prompt)
    │
    ├── tool calls, output streaming...
    │
    ▼
session.error (429, statusCode from SDK)
    │
    ├── binding.rotationInProgress = true
    ├── binding.isPaused = true
    │
    ▼
rotationCallback → sdkClientManager.rotateOnError()
    │
    ├── accountManager.rotateToNext() → Token B
    │
    ▼
performHealthCheck(Token B)
    │
    ├── createSession(healthCheckId) → sendAndWait("hi") → destroy
    │
    ▼
sdkClientManager.createSession(retryId, Token B)
    │
    ▼
rebindWithNewSession()
    │
    ├── oldSession.unsubscribe() + destroy()
    ├── Create new SessionBinding (preserving metrics)
    ├── newSession.on(event handler chain)
    ├── newSession.rpc.mode.set('autopilot')
    ├── newSession.rpc.fleet.start() (if fleet mode)
    ├── newSession.send(handoffPrompt)
    │
    ▼
New session running with Token B
    │
    ├── tool calls, output streaming...
    │
    ▼
session.idle → COMPLETED
```

## 6. Summary: What This Provider Implements

| Responsibility | How |
|----------------|-----|
| Task creation | `taskManager.createTask()` in spawner |
| PENDING → RUNNING | `bind()` sets status via `updateTask()` |
| Output streaming | Event handlers → `appendOutput()` / `appendOutputFileOnly()` |
| Tool tracking | `handleToolStart()` / `handleToolComplete()` with summarizer |
| Sub-agent tracking | `handleSubagentStarted()` / `handleSubagentCompleted()` |
| Metrics collection | `updateSessionMetrics()` aggregates binding state |
| Completion | `handleSessionIdle()` → COMPLETED |
| Error handling | `handleSessionError()` → rotation or FAILED/RATE_LIMITED |
| Rate limit recovery | `attemptRotationAndResume()` → new session with preserved state |
| Fallback trigger | `triggerClaudeFallback()` when all accounts exhausted |
| Cancellation | `handleAbort()` → CANCELLED, or `markTimedOut()` |
| Cleanup | `unbind()` — unsubscribe, clear data, destroy session |
| Process registration | `processRegistry.register()` after session creation |
| Question handling | `createUserInputHandler()` → `questionRegistry` |

---

**Previous:** [04 — Spawn Pipeline](./04-spawn-pipeline.md) · **Next:** [06 — Provider Reference: Claude](./06-provider-reference-claude.md)
