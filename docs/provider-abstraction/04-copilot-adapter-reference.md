# Copilot Adapter Reference

Defined in `src/providers/copilot-adapter.ts`. The primary provider in the default chain.

## Overview

`CopilotProviderAdapter` is a thin delegation layer. It does not contain Copilot SDK logic itself -- it routes calls to the existing service modules:

| Adapter Method | Delegates To |
|---|---|
| `checkAvailability()` | `accountManager.getCurrentToken()` |
| `spawn()` | `copilot-session-runner.ts` -> `executeWaitingTask()` |
| `abort()` | `sdkSessionAdapter.unbind()` + `processRegistry.killTask()` |
| `sendMessage()` | `spawnCopilotTask()` with `resumeSessionId` |
| `shutdown()` | `sdkSessionAdapter.cleanup()` + `shutdownSDK()` |
| `getStats()` | `getSDKStats()` |

All imports are lazy (`await import(...)` or `require(...)`) to break circular dependencies with service singletons.

## Capability Profile

```typescript
const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: true,
  supportsUserInput: true,
  supportsFleetMode: true,
  supportsCredentialRotation: true,
  maxConcurrency: Infinity, // Copilot manages concurrency via PTY FD recycling
};
```

Copilot is the only provider with all capabilities enabled. `maxConcurrency: Infinity` because concurrency is managed externally via PTY file descriptor recycling (threshold: 80 ptmx FDs) in `sdk-client-manager.ts`, not at the adapter level.

## `checkAvailability()`

Uses a synchronous `require()` (not `await import()`) because `selectProvider()` calls this in a tight loop and needs it to be fast.

```typescript
checkAvailability(): AvailabilityResult {
  try {
    const { accountManager } = require('../services/account-manager.js');
    const token = accountManager.getCurrentToken();
    if (!token) {
      return {
        available: false,
        reason: 'No PAT tokens configured or all tokens in cooldown',
      };
    }
    return { available: true };
  } catch {
    return { available: false, reason: 'Account manager not initialized' };
  }
}
```

The `try/catch` handles the case where `account-manager.js` has not been initialized yet (startup ordering) or has been torn down during shutdown.

### When Copilot is unavailable

- No `GITHUB_PAT_TOKENS` or numbered `GITHUB_PAT_TOKEN_N` env vars set
- All PAT tokens are in cooldown (failed within the last 60 seconds)
- Account manager not initialized (race during startup)

When Copilot is unavailable, the registry falls through to the next provider in the chain (typically `codex`).

## `spawn()` Delegation Path

```
CopilotProviderAdapter.spawn(options)
  |
  v
copilot-session-runner.ts: runCopilotSession(options)
  |
  v
sdk-spawner.ts: executeWaitingTask(task)
  |
  +--> taskManager.updateTask(taskId, { status: RUNNING })
  +--> sdkClientManager.createSession()
  +--> sdkSessionAdapter.bind(taskId, session)
  +--> session.rpc.mode.set({ mode: 'autopilot' })
  +--> (if fleet) session.rpc.fleet.start()
  +--> session.send(finalPrompt)   // fire-and-forget
```

The adapter's `spawn()` does a lazy import and delegates:

```typescript
async spawn(options: ProviderSpawnOptions): Promise<void> {
  const { runCopilotSession } = await import('./copilot-session-runner.js');
  await runCopilotSession(options);
}
```

`copilot-session-runner.ts` is the bridge between the adapter interface and the existing `executeWaitingTask()` function from `sdk-spawner.ts`. The key point: the task already exists in `PENDING` state (created by `shared-spawn.ts`). The runner updates it with timeout and mode, then delegates:

```typescript
export async function runCopilotSession(options: ProviderSpawnOptions): Promise<void> {
  const { taskId, prompt, cwd, model, timeout, mode, reasoningEffort } = options;

  const task = taskManager.getTask(taskId);
  if (!task || isTerminalStatus(task.status)) {
    console.error(`[copilot-session-runner] Task ${taskId} not found or already terminal`);
    return;
  }

  const { executeWaitingTask } = await import('../services/sdk-spawner.js');

  taskManager.updateTask(taskId, {
    timeout,
    mode: mode ?? DEFAULT_AGENT_MODE,
  });

  try {
    await executeWaitingTask(task);
  } catch (err) {
    const currentTask = taskManager.getTask(taskId);
    if (currentTask && !isTerminalStatus(currentTask.status)) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: `Copilot session startup failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      });
    }
  }
}
```

`executeWaitingTask()` handles the full session lifecycle internally: session creation, event binding via `sdk-session-adapter.ts`, mode activation (autopilot + fleet), prompt sending, and error/rotation/fallback paths.

## `abort()`

Two-step cleanup: unbind the session adapter (stops event processing), then kill the process.

```typescript
async abort(taskId: string, reason?: string): Promise<boolean> {
  const { sdkSessionAdapter } = await import('../services/sdk-session-adapter.js');
  const { processRegistry } = await import('../services/process-registry.js');

  sdkSessionAdapter.unbind(taskId);
  return processRegistry.killTask(taskId);
}
```

`processRegistry.killTask()` follows the standard kill escalation chain:
1. `session.abort()` with 5s timeout
2. `abortController.abort()`
3. SIGTERM to PID/PGID
4. Wait 3 seconds
5. SIGKILL if still alive

## `sendMessage()`

Creates a new task that resumes the original Copilot session. Uses the existing `spawnCopilotTask()` from `sdk-spawner.ts` with the original session's `sessionId` as `resumeSessionId`:

```typescript
async sendMessage(taskId: string, message: string, options: ProviderSpawnOptions): Promise<string> {
  const { spawnCopilotTask } = await import('../services/sdk-spawner.js');
  const { taskManager } = await import('../services/task-manager.js');

  const originalTask = taskManager.getTask(taskId);

  const newTaskId = await spawnCopilotTask({
    prompt: message,
    timeout: options.timeout,
    cwd: options.cwd,
    resumeSessionId: originalTask?.sessionId,
    labels: [...(originalTask?.labels || []), `continued-from:${taskId}`],
  });

  return newTaskId;
}
```

The new task gets a `continued-from:{original-task-id}` label for traceability.

## `shutdown()`

Cleans up all session bindings, then shuts down the SDK client:

```typescript
async shutdown(): Promise<void> {
  const { shutdownSDK } = await import('../services/sdk-spawner.js');
  const { sdkSessionAdapter } = await import('../services/sdk-session-adapter.js');

  sdkSessionAdapter.cleanup();
  await shutdownSDK();
}
```

## `getStats()`

Delegates to the SDK spawner's stats export. Uses synchronous `require()` because stats are a simple data fetch:

```typescript
getStats(): Record<string, unknown> {
  try {
    const { getSDKStats } = require('../services/sdk-spawner.js');
    return getSDKStats();
  } catch {
    return { error: 'SDK stats unavailable' };
  }
}
```

## Configuration Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_PAT_TOKENS` | (none) | Comma-separated PAT tokens (primary config) |
| `GITHUB_PAT_TOKEN_1`..`_100` | (none) | Numbered PAT tokens |
| `GH_PAT_TOKEN` | (none) | Comma-separated fallback |
| `GITHUB_TOKEN` / `GH_TOKEN` | (none) | Single-token fallback |
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI binary |
| `DEBUG_SDK_EVENTS` | `false` | Log all SDK events to stderr |

If no PAT tokens are configured, `checkAvailability()` returns `{ available: false }` and the registry skips Copilot, falling through to the next provider in the chain.

## Session ID vs Task ID

After a token rotation during a Copilot session, the session gets a new ID with the format `{taskId}-r{N}` (where N is the rotation count). The `sdkClientManager.sessionOwners` map resolves session IDs back to task IDs. Never assume `sessionId === taskId` after the task has started running.
