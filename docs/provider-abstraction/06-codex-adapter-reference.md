# 06 — Codex Adapter Reference

## Overview

`CodexProviderAdapter` integrates the `@openai/codex-sdk` as a full provider. Unlike the Claude adapter (which delegates to an existing runner), the Codex adapter contains the complete execution loop: SDK instantiation, thread creation, event streaming, metrics collection, and cleanup.

**Source:** `src/providers/codex-adapter.ts`
**SDK:** `@openai/codex-sdk`

## Capability Profile

```typescript
const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: false,
  supportsUserInput: false,
  supportsFleetMode: false,
  supportsCredentialRotation: false,
  maxConcurrency: MAX_CONCURRENCY, // default 5
};
```

All capability flags are `false`. Codex threads are one-shot — no session resume, no interactive user input, no fleet sub-agents, and API keys are static (no rotation).

## Availability Check

Three conditions must pass:

```typescript
checkAvailability(): AvailabilityResult {
  if (process.env.DISABLE_CODEX_FALLBACK === 'true') {
    return { available: false, reason: 'Codex disabled (DISABLE_CODEX_FALLBACK=true)' };
  }
  if (!CODEX_API_KEY) {
    return { available: false, reason: 'No API key configured (set OPENAI_API_KEY or CODEX_API_KEY)' };
  }
  if (activeSessions >= MAX_CONCURRENCY) {
    return {
      available: false,
      reason: `Concurrency limit reached (${activeSessions}/${MAX_CONCURRENCY})`,
      retryAfterMs: 10_000,
    };
  }
  return { available: true };
}
```

The `retryAfterMs` hint tells the registry that this provider may become available after a short wait. The registry does not currently act on this hint but it is available for future use.

## spawn() — Full Execution Loop

The Codex adapter owns its entire execution lifecycle, unlike the Copilot and Claude adapters which delegate to existing runners.

### Setup Phase

```typescript
// Concurrency guard
if (activeSessions >= MAX_CONCURRENCY) {
  taskManager.updateTask(taskId, {
    status: TaskStatus.FAILED,
    error: `Codex concurrency limit reached (${MAX_CONCURRENCY})`,
    endTime: new Date().toISOString(),
    exitCode: 1,
  });
  return;
}
activeSessions++;

// Create abort controller for cancellation
const abortController = new AbortController();
activeControllers.set(taskId, abortController);

// Register with process registry for kill escalation
processRegistry.register({
  taskId,
  abortController,
  registeredAt: Date.now(),
  label: 'codex-session',
});

// Timeout timer (must .unref() to not block process exit)
const timeoutTimer = setTimeout(() => {
  abortController.abort();
}, timeout);
timeoutTimer.unref();
```

### SDK Instantiation and Thread Creation

```typescript
const codex = new Codex({
  apiKey: CODEX_API_KEY,
  codexPathOverride: CODEX_PATH,
});

const codexModel = model === 'sonnet' || model === 'opus' ? CODEX_MODEL : (model || CODEX_MODEL);

const thread = codex.startThread({
  model: codexModel,
  workingDirectory: cwd,
  sandboxMode: CODEX_SANDBOX_MODE,
  approvalPolicy: CODEX_APPROVAL_POLICY,
  skipGitRepoCheck: true,
});
```

### Model Mapping

When the MCP client passes Anthropic model names (`sonnet`, `opus`), the adapter maps them to the configured `CODEX_MODEL` (default: `o4-mini`). Other model names are passed through as-is, allowing callers to specify OpenAI models directly.

```typescript
const codexModel = model === 'sonnet' || model === 'opus' ? CODEX_MODEL : (model || CODEX_MODEL);
```

### Event Stream Mapping

The Codex SDK returns an `AsyncGenerator<ThreadEvent>` from `thread.runStreamed()`. Each event type maps to specific `taskManager` calls:

| ThreadEvent type | Action |
|---|---|
| `thread.started` | Store `thread_id` as `sessionId`, log start |
| `turn.started` | Increment turn counter, append `--- Turn N ---` |
| `turn.completed` | Accumulate token usage (input + output) |
| `turn.failed` | Append error message |
| `item.started` (agent_message) | No-op (content arrives via `item.updated`) |
| `item.started` (reasoning) | Append first 200 chars of reasoning text |
| `item.started` (command_execution) | Append command string |
| `item.started` (file_change) | Append path and kind per change |
| `item.started` (mcp_tool_call) | Append server:tool name |
| `item.started` (web_search) | Append search query |
| `item.started` (todo_list) | Append checklist items |
| `item.started` (error) | Append error message |
| `item.updated` (agent_message) | Append full message text |
| `item.completed` (command_execution) | Track tool metrics (success/failure), append exit code |
| `item.completed` (file_change) | Track tool metrics, append change count |
| `item.completed` (mcp_tool_call) | Track tool metrics with `mcp:server:tool` key |
| `error` | Append error message |

Between each event, the adapter re-fetches the task to check for cancellation:

```typescript
for await (const event of events) {
  const currentTask = taskManager.getTask(taskId);
  if (!currentTask || isTerminalStatus(currentTask.status)) {
    break;
  }
  // ... handle event
}
```

### Completion

After the event stream ends, if the task is still non-terminal:

```typescript
taskManager.updateTask(taskId, {
  status: TaskStatus.COMPLETED,
  endTime: new Date().toISOString(),
  exitCode: 0,
  providerState: undefined,
  sessionMetrics: {
    quotas: {},
    toolMetrics: Object.fromEntries(
      Object.entries(toolMetrics).map(([name, m]) => [name, {
        toolName: name,
        executionCount: m.count,
        successCount: m.successCount,
        failureCount: m.failureCount,
        totalDurationMs: 0,
      }]),
    ),
    activeSubagents: [],
    completedSubagents: [],
    turnCount,
    totalTokens,
  },
});
```

### Error Handling

| Scenario | Status | Notes |
|---|---|---|
| `abortController.signal.aborted` | CANCELLED | Triggered by `abort()` or timeout |
| Any other error | FAILED | Error message stored in `task.error` |
| Terminal state detected mid-stream | Break loop | No status change (already terminal) |

## Cancellation via AbortController

```typescript
async abort(taskId: string, reason?: string): Promise<boolean> {
  const controller = activeControllers.get(taskId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}
```

The `AbortController.signal` is passed to `thread.runStreamed()`. When aborted, the SDK terminates the thread and the `for await` loop throws, caught by the error handler which checks `abortController.signal.aborted` to set CANCELLED rather than FAILED.

## Concurrency Limiting

Unlike Copilot (which uses PTY FD recycling for implicit concurrency) or Claude (which uses a queue-based slot system inside `claude-code-runner.ts`), Codex manages concurrency directly in the adapter:

```typescript
let activeSessions = 0;

// In checkAvailability():
if (activeSessions >= MAX_CONCURRENCY) { ... }

// In spawn():
activeSessions++;

// In finally block:
activeSessions = Math.max(0, activeSessions - 1);
```

The `Math.max(0, ...)` guard prevents underflow from unexpected double-decrement.

## shutdown()

```typescript
async shutdown(): Promise<void> {
  for (const [taskId, controller] of activeControllers) {
    console.error(`[codex-adapter] Shutting down session for task ${taskId}`);
    controller.abort();
  }
  activeControllers.clear();
  activeSessions = 0;
}
```

Aborts all active controllers and resets counters. No graceful drain — threads are terminated immediately.

## Configuration Environment Variables

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | (required) | API key for Codex SDK (primary) |
| `CODEX_API_KEY` | (required) | API key for Codex SDK (alternative, checked first) |
| `CODEX_PATH` | (auto) | Override path to Codex CLI binary |
| `CODEX_MODEL` | `o4-mini` | Default model for Codex threads |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Sandbox: `read-only`, `workspace-write`, `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never` | Approval: `never`, `on-request`, `on-failure`, `untrusted` |
| `MAX_CONCURRENT_CODEX_SESSIONS` | `5` | Max parallel Codex threads |
| `DISABLE_CODEX_FALLBACK` | `false` | Disables Codex in `checkAvailability()` |

## Stats

```typescript
getStats(): Record<string, unknown> {
  return {
    activeSessions,
    maxConcurrency: MAX_CONCURRENCY,
    apiKeyConfigured: !!CODEX_API_KEY,
    model: CODEX_MODEL,
    sandboxMode: CODEX_SANDBOX_MODE,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    disabled: process.env.DISABLE_CODEX_FALLBACK === 'true',
  };
}
```

Richer stats than Claude — includes active session count, configured model, sandbox mode, and approval policy.
