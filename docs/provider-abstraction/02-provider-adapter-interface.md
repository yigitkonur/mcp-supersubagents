# Provider Adapter Interface

## ProviderAdapter

Defined in `src/providers/types.ts`. This is the contract every AI provider must implement.

```typescript
export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  checkAvailability(): AvailabilityResult;
  getCapabilities(): ProviderCapabilities;
  spawn(options: ProviderSpawnOptions): Promise<void>;
  abort(taskId: string, reason?: string): Promise<boolean>;
  sendMessage?(taskId: string, message: string, options: ProviderSpawnOptions): Promise<string>;
  shutdown(): Promise<void>;
  getStats(): Record<string, unknown>;
}
```

### Method-by-Method

#### `id: string` (readonly)

Unique identifier matching one of the registered provider IDs: `'copilot'`, `'claude-cli'`, `'codex'`. Used in chain configuration, task state (`task.provider`), and log prefixes.

#### `displayName: string` (readonly)

Human-readable name for logs and error messages. Examples: `'GitHub Copilot SDK'`, `'Claude Agent SDK'`, `'OpenAI Codex SDK'`.

#### `checkAvailability(): AvailabilityResult`

Called by `providerRegistry.selectProvider()` during provider selection. Must be fast -- it runs synchronously in a loop over the chain.

Typical checks:
- Are credentials configured? (PAT tokens, API keys)
- Is the provider disabled via env var?
- Has the concurrency limit been reached?

```typescript
// From copilot-adapter.ts
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

#### `getCapabilities(): ProviderCapabilities`

Returns a static capabilities object. Used by tool handlers (`send_message`, `cancel_task`) to check feature support before dispatching. Called on demand, not during selection.

#### `spawn(options: ProviderSpawnOptions): Promise<void>`

The core execution method. Called inside a `setImmediate` callback from `shared-spawn.ts`. The task already exists in `PENDING` state when this is called.

**Provider responsibilities:**
1. Transition task to `RUNNING` via `taskManager.updateTask()`
2. Execute the prompt against the AI backend
3. Stream output via `taskManager.appendOutput()`
4. Transition to `COMPLETED` or `FAILED` when done
5. Check `isTerminalStatus()` after every `await` (the task may have been cancelled concurrently)

**Error handling:** Errors should be caught internally and reflected as `FAILED` status, not thrown. If `spawn()` does throw, the caller in `shared-spawn.ts` catches it and triggers `triggerFallback()`.

#### `abort(taskId: string, reason?: string): Promise<boolean>`

Called by `cancel_task` tool and timeout handlers. Returns `true` if abort was initiated. The provider must clean up its resources (sessions, processes, abort controllers).

```typescript
// From codex-adapter.ts
async abort(taskId: string, reason?: string): Promise<boolean> {
  const controller = activeControllers.get(taskId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}
```

#### `sendMessage?(taskId: string, message: string, options: ProviderSpawnOptions): Promise<string>`

Optional. Only implemented when `supportsSessionResume` is `true`. Sends a follow-up message to an existing session, creating a new task for the continuation. Returns the new task ID.

Currently only `CopilotProviderAdapter` implements this, delegating to `spawnCopilotTask()` with a `resumeSessionId`.

#### `shutdown(): Promise<void>`

Called during server exit. Must abort all active sessions and clean up resources. Called by `providerRegistry.shutdownAll()` which uses `Promise.allSettled` -- so one provider's shutdown failure does not block others.

#### `getStats(): Record<string, unknown>`

Returns runtime statistics for the `system:///status` MCP resource. Free-form object. Examples: active session count, configuration values, disabled status.

---

## ProviderCapabilities

```typescript
export interface ProviderCapabilities {
  supportsSessionResume: boolean;
  supportsUserInput: boolean;
  supportsFleetMode: boolean;
  supportsCredentialRotation: boolean;
  maxConcurrency: number;
}
```

| Field | Meaning | Copilot | Claude | Codex |
|---|---|---|---|---|
| `supportsSessionResume` | Can send follow-up messages to a completed session | `true` | `false` | `false` |
| `supportsUserInput` | Can handle `ask_user` prompts via question registry | `true` | `false` | `false` |
| `supportsFleetMode` | Has native parallel sub-agent execution | `true` | `false` | `false` |
| `supportsCredentialRotation` | Can rotate credentials mid-session on rate limit | `true` | `false` | `false` |
| `maxConcurrency` | Maximum concurrent sessions | `Infinity` | `3` | `5` |

Capabilities are static per provider (returned from `getCapabilities()`). They are checked by tool handlers before dispatching operations that not all providers support.

---

## ProviderSpawnOptions

```typescript
export interface ProviderSpawnOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  model: string;
  timeout: number;
  mode: AgentMode;
  reasoningEffort?: ReasoningEffort;
  resumeSessionId?: string;
  labels?: string[];
  taskType?: string;
}
```

| Field | Source | Notes |
|---|---|---|
| `taskId` | `taskManager.createTask()` | Task already exists in `PENDING` state |
| `prompt` | `applyTemplate()` output | Fully assembled: template + overlay + context + user prompt |
| `cwd` | User param or `clientContext.getDefaultCwd()` | Working directory for the AI session |
| `model` | `resolveModel()` | After model resolution (planner always Opus) |
| `timeout` | User param or `TASK_TIMEOUT_DEFAULT_MS` | In milliseconds |
| `mode` | User param or `DEFAULT_AGENT_MODE` | `'fleet'`, `'plan'`, or `'autopilot'` |
| `reasoningEffort` | User param (optional) | Provider-specific reasoning level |
| `resumeSessionId` | `sendMessage()` flow only | Copilot session ID to resume |
| `labels` | User param (optional) | Task labels for filtering |
| `taskType` | Spawn config | e.g., `'super-coder'`, `'super-planner'` |

---

## AvailabilityResult

```typescript
export interface AvailabilityResult {
  available: boolean;
  reason?: string;
  retryAfterMs?: number;
}
```

Returned by `checkAvailability()`. When `available` is `false`:
- `reason` is logged by the registry during selection
- `retryAfterMs` is a hint for rate-limit cooldowns (used by Codex when at concurrency limit)

---

## FallbackRequest

```typescript
export interface FallbackRequest {
  taskId: string;
  failedProviderId: string;
  reason: string;
  errorMessage?: string;
  cwd?: string;
  promptOverride?: string;
  awaitCompletion?: boolean;
}
```

Passed to `triggerFallback()` when a provider fails mid-task. The `failedProviderId` is used to find the next provider in the chain. `promptOverride` allows the fallback to use a modified prompt (typically the original assembled prompt). `awaitCompletion` controls whether `triggerFallback()` awaits the fallback session or fires and forgets.

---

## Lifecycle

```
1. Construction (startup)
   new CopilotProviderAdapter()
   new CodexProviderAdapter()
   new ClaudeProviderAdapter()

2. Registration
   providerRegistry.register(adapter)

3. Chain configuration
   providerRegistry.configureChain(parseChainString(env))

4. Provider selection (per task)
   providerRegistry.selectProvider()
     -> adapter.checkAvailability()

5. Task execution
   adapter.spawn(options)
     -> PENDING -> RUNNING -> COMPLETED|FAILED

6. Abort (on cancel_task or timeout)
   adapter.abort(taskId, reason)

7. Shutdown (server exit)
   providerRegistry.shutdownAll()
     -> adapter.shutdown() for each
```

---

## Rules for Provider Implementations

1. **All logging via `console.error`.** A single `console.log` corrupts the MCP STDIO JSON-RPC framing.

2. **Use `taskManager.updateTask()` for state changes.** This uses `Object.assign` to preserve the Map reference. Never create a new task object.

3. **Check `isTerminalStatus()` after every `await`.** The task may have been cancelled or timed out by another code path while your async operation was in flight.

4. **Register with `processRegistry` for kill escalation.** This enables the kill chain: `abort()` -> SIGTERM -> 3s wait -> SIGKILL.

5. **Call `.unref()` on all timers.** Prevents Node.js from staying alive during shutdown waiting on a stale `setTimeout`.

6. **Use lazy imports (`await import(...)`) to break circular dependencies.** Provider adapters import service singletons that may import providers. Import inside methods, not at module scope.

7. **Handle the `spawn()` error boundary internally.** Catch errors and set `FAILED` status rather than letting exceptions propagate. The caller has a catch for fallback, but the provider should be self-contained.

8. **Single-flight guards for sensitive operations.** Use boolean flags (checked before first await, set immediately, cleared in finally) to prevent concurrent execution of operations like fallback or rotation.
