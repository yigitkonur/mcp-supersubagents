# 06 — Codex Adapter Reference

## Overview

`CodexProviderAdapter` integrates OpenAI Codex as a full provider with two execution modes: **app-server protocol** (default, full-featured) and **SDK mode** (legacy fallback via `@openai/codex-sdk`).

The app-server mode uses `CodexAppServerClient` (`src/providers/codex-app-server.ts`) which implements the Codex app-server JSON-RPC 2.0 protocol over stdio transport. This enables bidirectional communication, session resume via `thread/resume`, user input via `ask_user`, and graceful cancellation via `turn/interrupt`.

The adapter auto-detects the `codex` CLI binary at startup. If found, app-server mode is used by default. SDK mode is available as a fallback or can be forced with `CODEX_USE_SDK=true`.

**Source:** `src/providers/codex-adapter.ts`, `src/providers/codex-app-server.ts`
**SDK:** `@openai/codex-sdk` (fallback only)

## Capability Profile

```typescript
const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: USE_APP_SERVER, // via thread/resume (app-server mode only)
  supportsUserInput: USE_APP_SERVER,     // via ask_user question registry (app-server mode only)
  supportsFleetMode: false,
  supportsCredentialRotation: false,
  maxConcurrency: MAX_CONCURRENCY, // default 5
};
```

Session resume and user input are enabled only when the provider is running in app-server mode. In forced SDK mode (`CODEX_USE_SDK=true`) or when the app-server binary is unavailable, both capabilities are reported as unsupported. Fleet mode and credential rotation are not supported. API keys are static (no rotation).

## Availability Check

Four conditions are checked via a Cockatiel resilience policy (bulkhead + circuit breaker):

```typescript
checkAvailability(): AvailabilityResult {
  if (process.env.DISABLE_CODEX_FALLBACK === 'true') {
    return { available: false, reason: 'Codex disabled (DISABLE_CODEX_FALLBACK=true)' };
  }
  if (!CODEX_API_KEY && !HAS_CLI_AUTH) {
    return {
      available: false,
      reason: 'No auth configured (set OPENAI_API_KEY or CODEX_API_KEY, or run `codex auth` for CLI auth)',
    };
  }
  if (!policy.isHealthy()) {
    return {
      available: false,
      reason: `Circuit breaker open (${policy.getStats().circuitState})`,
      retryAfterMs: 30_000,
    };
  }
  if (policy.isFull()) {
    return {
      available: false,
      reason: `Concurrency limit reached (${policy.getStats().executionSlots}/${MAX_CONCURRENCY})`,
      retryAfterMs: 10_000,
    };
  }
  return { available: true };
}
```

Authentication is flexible: either an API key (`OPENAI_API_KEY` / `CODEX_API_KEY`) or Codex CLI auth (`~/.codex/auth.json`, e.g., ChatGPT OAuth) satisfies the auth check. The circuit breaker opens after 5 consecutive failures and half-opens after 30s.

## Mode Auto-Detection

The adapter auto-detects app-server mode at startup:

```typescript
const FORCE_SDK_MODE = process.env.CODEX_USE_SDK === 'true';

function detectAppServerAvailable(): boolean {
  if (FORCE_SDK_MODE) return false;
  const binary = findCodexBinary(CODEX_PATH);
  if (binary === 'codex') {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(lookup, ['codex'], { stdio: 'ignore' }).status === 0;
  }
  return existsSync(binary);
}

const USE_APP_SERVER = detectAppServerAvailable();
```

Binary resolution checks (in order):
1. Explicit `CODEX_PATH` override
2. Vendored binary in `@openai/codex-{platform}-{arch}` package
3. `codex` from PATH

## spawn() — Dual Execution Mode

The adapter extends `BaseProviderAdapter`, which handles abort controller, timeout, mode suffix, cleanup, and `processRegistry` integration. The adapter implements `executeSession()` which dispatches to one of two modes:

```typescript
protected async executeSession(handle, prompt, signal, options): Promise<void> {
  if (USE_APP_SERVER) {
    await this.executeSessionWithAppServer(handle, prompt, signal, options);
  } else {
    await this.executeSessionWithSDK(handle, prompt, signal, options);
  }
}
```

### App-Server Mode (Default)

Full execution flow using `CodexAppServerClient`:

1. **Process spawn**: `codex app-server --listen stdio://` — registered with `processRegistry` for kill escalation
2. **Initialize handshake**: JSON-RPC `initialize` with `experimentalApi: true`, followed by `initialized` notification
3. **Thread start/resume**: `thread/start` for new sessions, `thread/resume` for `sendMessage()` continuations
4. **Turn execution**: `turn/start` with the prompt — streams notifications and handles server requests
5. **Completion**: `turn/completed` ends the turn (with `turn/failed` tolerated as a legacy/backward-compatible signal)

```typescript
// Simplified app-server flow
const client = new CodexAppServerClient({ codexPath: CODEX_PATH, apiKey: CODEX_API_KEY });
await client.start(signal, taskId);

const threadId = options.resumeSessionId
  ? await client.resumeThread(options.resumeSessionId, threadOptions)
  : await client.startThread(threadOptions);

for await (const msg of client.runTurn(prompt)) {
  if (handle.isTerminal()) break;
  if (msg.kind === 'notification') handleNotification(msg);
  else if (msg.kind === 'request') await handleRequest(msg);
}
```

All operations execute inside `policy.execute()` — the Cockatiel bulkhead enforces concurrency and the circuit breaker tracks health.

### SDK Mode (Fallback)

Uses `@openai/codex-sdk`'s `Codex` class with `thread.runStreamed()`. No user input support — the SDK filters events to a simpler stream. Activated when:
- `CODEX_USE_SDK=true` is set explicitly
- The `codex` binary is not found at startup

### Notification Mapping (App-Server Mode)

| Notification Method | Action |
|---|---|
| `turn/started` | Increment turn counter, append `--- Turn N ---` |
| `turn/completed` | Inspect terminal turn status / error |
| `thread/tokenUsage/updated` | Accumulate token usage from `tokenUsage.last` |
| `turn/failed` | Append error message |
| `item/agentMessage/delta` | Append `params.delta` text |
| `item/started` (reasoning) | Append preview from `summary` / `content` (file-only) |
| `item/started` (commandExecution) | Append command string |
| `item/started` (fileChange) | Append path and kind per change |
| `item/started` (mcpToolCall) | Append server:tool name |
| `item/started` (webSearch) | Append search query |
| `item/started` (error) | Append error message |
| `item/completed` (commandExecution) | Track tool metrics, append `exitCode` |
| `item/completed` (fileChange) | Track tool metrics, append change count |
| `item/completed` (mcpToolCall) | Track tool metrics with `mcp:server:tool` key |
| `turn/diff/updated` | Log the latest aggregated unified diff snapshot |
| `turn/plan/updated` | Append plan summary (file-only) |
| `item/reasoning/summaryTextDelta` / `item/reasoning/textDelta` | Append reasoning deltas (file-only) |
| `item/commandExecution/outputDelta` | Append `params.delta` command output |
| `thread/status/changed` | Log a bounded human-readable thread status summary (file-only) |
| `serverRequest/resolved` | Log acknowledgment (file-only) |
| `error` | Append error message |

### Server Request Handling (App-Server Mode)

| Request Method | Response |
|---|---|
| `item/tool/requestUserInput` | Routes through `questionRegistry` — registers question, waits for user answer, responds with `{ answers: { [questionId]: { answers: string[] } } }` |
| `item/commandExecution/requestApproval` | Auto-approves: `{ decision: 'accept' }` |
| `item/fileChange/requestApproval` | Auto-approves: `{ decision: 'accept' }` |
| `item/tool/requestCommand` (legacy) | Auto-approves: `{ decision: 'accept' }` |
| `item/tool/requestFileChange` (legacy) | Auto-approves: `{ decision: 'accept' }` |
| `mcpServer/elicitation/request` | Responds with a valid cancellation payload: `{ action: 'cancel', content: null }` |

### Zombie Question Cleanup

If the app-server process dies while a `questionRegistry.register()` call is blocking, the adapter detects this via the question pending state and clears it in the `finally` block. The same `finally` block also destroys the completed `CodexAppServerClient` instance so finished turns do not leave orphaned `codex app-server` processes behind:

```typescript
if (questionRegistry.hasPendingQuestion(taskId)) {
  questionRegistry.clearQuestion(taskId, 'codex session ended');
}
```

### Error Classification

The adapter catches `CodexRpcError` instances and classifies them:

| Error Kind | Message | Notes |
|---|---|---|
| `ContextWindowExceeded` | "Context window exceeded — conversation too long" | Thread has exceeded the model's context limit |
| `UsageLimitExceeded` | "Usage limit exceeded — API quota exhausted" | API key rate limit or billing cap |
| `HttpConnectionFailed` | "HTTP connection failed — cannot reach OpenAI API" | Network/connectivity issue |

Classified errors are logged to the output file before re-throwing for the base class to handle state transition.

### Completion

After the turn stream ends, if the task is still alive:

```typescript
handle.markCompleted({
  turnCount,
  totalTokens,
  toolMetrics: Object.fromEntries(
    Object.entries(toolMetrics).map(([name, m]) => [name, {
      toolName: name,
      executionCount: m.count,
      successCount: m.successCount,
      failureCount: m.failureCount,
      totalDurationMs: 0,
    }]),
  ),
});
```

## sendMessage() — Session Resume via `thread/resume`

Creates a NEW task (same pattern as Copilot) and uses `thread/resume` to continue the conversation:

```typescript
async sendMessage(taskId: string, message: string, options): Promise<string> {
  const originalTask = taskManager.getTask(taskId);
  if (!originalTask?.sessionId) throw new Error('No session to resume');

  const newTask = taskManager.createTask(message, options.cwd, options.model, {
    isResume: true,
    labels: [...(originalTask.labels || []), `continued-from:${taskId}`],
    provider: 'codex',
    timeout: options.timeout,
  });

  setImmediate(() => {
    this.executeResumeSession(newTask.id, originalTask.sessionId, message, options);
  });

  return newTask.id;
}
```

The `executeResumeSession()` method starts a new `CodexAppServerClient`, calls `client.resumeThread(existingThreadId, ...)` to reconnect to the conversation, then runs a turn with the follow-up message. The original task stays terminal — only the new task transitions through PENDING → RUNNING → COMPLETED|FAILED.

If the provider is in SDK mode, `sendMessage()` now fails immediately with a clear "only supported in app-server mode" error instead of attempting a broken resume path.

## Cancellation — `turn/interrupt` Before Process Kill

The adapter implements a graceful abort sequence:

```typescript
async abort(taskId: string, reason?: string): Promise<boolean> {
  // 1. Clear any pending question immediately
  questionRegistry.clearQuestion(taskId, 'task aborted');

  // 2. Try graceful turn/interrupt via the client
  const client = this.activeClients.get(taskId);
  if (client && !client.isDestroyed) {
    const interrupted = await client.interruptTurn();
    // Give process 2s to wrap up after interrupt
    client.destroy();
  }

  // 3. Fall back to abort controller
  const controller = this.activeControllers.get(taskId);
  if (controller) { controller.abort(); return true; }

  // 4. Fall back to processRegistry kill escalation (SIGTERM → SIGKILL)
  return processRegistry.killTask(taskId);
}
```

`CodexAppServerClient` tracks the active `turnId` from `turn/start` / `turn/started` and includes both `threadId` and `turnId` when calling `turn/interrupt`. The interrupt call has a 5s internal timeout; if it times out, the adapter falls back to process kill.

## Concurrency — Cockatiel Resilience Policy

Unlike the manual `activeSessions` counter used previously, concurrency is now managed via a Cockatiel bulkhead + circuit breaker:

```typescript
const policy = createProviderPolicy({
  providerId: 'codex',
  maxConcurrency: MAX_CONCURRENCY,  // default 5
  queueSize: 0,                      // reject immediately if full
  breakerThreshold: 5,               // open after 5 failures
  halfOpenAfterMs: 30_000,           // try again after 30s
});
```

All session execution runs inside `policy.execute()`, which enforces the concurrency limit and tracks circuit breaker health. `checkAvailability()` queries `policy.isFull()` and `policy.isHealthy()`.

## shutdown()

```typescript
async shutdown(): Promise<void> {
  // Destroy all active clients (kills processes)
  for (const [taskId, client] of this.activeClients) {
    try { client.destroy(); } catch { /* swallow */ }
  }
  this.activeClients.clear();

  // Abort remaining controllers
  for (const [taskId, controller] of this.activeControllers) {
    controller.abort();
  }
  this.activeControllers.clear();
}
```

Client destruction kills the `codex app-server` process (SIGTERM → 3s wait → SIGKILL) and unregisters from `processRegistry`. Abort controllers are triggered as a fallback for any sessions not using a client.

## `codex-app-server.ts` — JSON-RPC Client

The `CodexAppServerClient` class implements the Codex app-server v2 JSON-RPC 2.0 protocol over JSONL stdio transport.

### Resilience Features

| Feature | Implementation |
|---|---|
| Request timeout | 60s via `Promise.race()` — rejects with `CodexRpcError` code `-32000` |
| Backpressure retry | Exponential backoff (1s→2s→4s) on error code `-32001`, max 3 retries |
| Process registration | Registers PID with `processRegistry` on `start()`, unregisters on `destroy()` |
| Kill escalation | `destroy()` sends SIGTERM, waits 3s, sends SIGKILL |
| Graceful interrupt | `interruptTurn()` sends `turn/interrupt` with `threadId + turnId` and a 5s timeout |
| Turn lifecycle cleanup | `trackTurnLifecycle()` clears `turnId` on both `turn/completed` and `turn/failed` |

### Thread ID Extraction

The protocol returns thread IDs nested in the response:

```typescript
// Protocol response: { thread: { id: "uuid" }, model: "...", sandbox: {...} }
const threadId = (
  result?.threadId ??
  result?.thread_id ??
  (result?.thread as Record<string, unknown> | undefined)?.id
) as string | undefined;
```

Multiple extraction paths handle both the documented response format (`result.thread.id`) and potential legacy formats.

## Configuration Environment Variables

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | (optional*) | API key for Codex (primary) |
| `CODEX_API_KEY` | (optional*) | API key for Codex (alternative, checked first) |
| `CODEX_PATH` | (auto) | Override path to Codex CLI binary |
| `CODEX_MODEL` | `o4-mini` | Default model for Codex threads |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Sandbox: `read-only`, `workspace-write`, `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never` | Approval: `never`, `on-request`, `on-failure`, `untrusted` |
| `MAX_CONCURRENT_CODEX_SESSIONS` | `5` | Max parallel Codex threads |
| `DISABLE_CODEX_FALLBACK` | `false` | Disables Codex in `checkAvailability()` |
| `CODEX_USE_SDK` | `false` | Force SDK mode instead of app-server |

*At least one auth method is required: API key (`OPENAI_API_KEY` or `CODEX_API_KEY`) or Codex CLI auth (`~/.codex/auth.json`).

## Stats

```typescript
getStats(): Record<string, unknown> {
  return {
    circuitState: policyStats.circuitState,
    executionSlots: policyStats.executionSlots,
    queueSlots: policyStats.queueSlots,
    maxConcurrency: MAX_CONCURRENCY,
    apiKeyConfigured: !!CODEX_API_KEY,
    cliAuthConfigured: HAS_CLI_AUTH,
    model: CODEX_MODEL,
    sandboxMode: CODEX_SANDBOX_MODE,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    disabled: process.env.DISABLE_CODEX_FALLBACK === 'true',
    appServerMode: USE_APP_SERVER,
    forceSdkMode: FORCE_SDK_MODE,
    activeClients: this.activeClients.size,
  };
}
```

The richest stats of all providers — includes circuit breaker state, execution slot availability, active client count, auth source, and execution mode.
