# 07 — Adding a New Provider

Step-by-step cookbook for integrating a new AI provider into the provider abstraction layer.

## Steps

### 1. Create the Adapter File

Create `src/providers/<name>-adapter.ts`. The file exports a class implementing `ProviderAdapter`.

### 2. Implement ProviderAdapter

Start from this template, replacing `example` with your provider name:

```typescript
/**
 * Example Provider Adapter
 */

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration (read once at module load)
// ---------------------------------------------------------------------------

const API_KEY = process.env.EXAMPLE_API_KEY || '';
const parsedMax = parseInt(process.env.MAX_CONCURRENT_EXAMPLE_SESSIONS || '5', 10);
const MAX_CONCURRENCY = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 5;

const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: false,
  supportsUserInput: false,
  supportsFleetMode: false,
  supportsCredentialRotation: false,
  maxConcurrency: MAX_CONCURRENCY,
};

// ---------------------------------------------------------------------------
// Active session tracking
// ---------------------------------------------------------------------------

const activeControllers = new Map<string, AbortController>();
let activeSessions = 0;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ExampleProviderAdapter implements ProviderAdapter {
  readonly id = 'example';                    // Must match the Provider type union
  readonly displayName = 'Example AI SDK';

  checkAvailability(): AvailabilityResult {
    if (process.env.DISABLE_EXAMPLE === 'true') {
      return { available: false, reason: 'Example disabled' };
    }
    if (!API_KEY) {
      return { available: false, reason: 'No API key (set EXAMPLE_API_KEY)' };
    }
    if (activeSessions >= MAX_CONCURRENCY) {
      return {
        available: false,
        reason: `Concurrency limit (${activeSessions}/${MAX_CONCURRENCY})`,
        retryAfterMs: 10_000,
      };
    }
    return { available: true };
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  async spawn(options: ProviderSpawnOptions): Promise<void> {
    // Lazy import SDK to avoid load-time errors if not installed
    const { ExampleSDK } = await import('example-sdk');
    const { taskManager } = await import('../services/task-manager.js');
    const { processRegistry } = await import('../services/process-registry.js');
    const { isTerminalStatus, TaskStatus } = await import('../types.js');

    const { taskId, prompt, cwd, model, timeout, mode } = options;

    const task = taskManager.getTask(taskId);
    if (!task || isTerminalStatus(task.status)) return;

    // Concurrency guard
    if (activeSessions >= MAX_CONCURRENCY) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        error: `Example concurrency limit reached`,
        endTime: new Date().toISOString(),
        exitCode: 1,
      });
      return;
    }
    activeSessions++;

    const abortController = new AbortController();
    activeControllers.set(taskId, abortController);

    processRegistry.register({
      taskId,
      abortController,
      registeredAt: Date.now(),
      label: 'example-session',
    });

    const timeoutTimer = setTimeout(() => abortController.abort(), timeout);
    timeoutTimer.unref();  // CRITICAL: .unref() prevents blocking process exit

    try {
      // Mark RUNNING
      taskManager.updateTask(taskId, {
        status: TaskStatus.RUNNING,
        provider: 'example' as any,
      });

      // Append mode suffix prompt
      const { getModeSuffixPrompt } = await import('../config/mode-prompts.js');
      const modeSuffix = getModeSuffixPrompt(mode);
      const finalPrompt = modeSuffix ? `${prompt}\n\n${modeSuffix}` : prompt;

      // --- Your SDK execution loop here ---
      // Stream events, call taskManager.appendOutput() for each,
      // check isTerminalStatus() after every await.

      // Mark COMPLETED
      const finalTask = taskManager.getTask(taskId);
      if (finalTask && !isTerminalStatus(finalTask.status)) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.COMPLETED,
          endTime: new Date().toISOString(),
          exitCode: 0,
          providerState: undefined,
        });
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        const t = taskManager.getTask(taskId);
        if (t && !isTerminalStatus(t.status)) {
          taskManager.updateTask(taskId, {
            status: TaskStatus.CANCELLED,
            endTime: new Date().toISOString(),
            error: 'Session aborted',
            providerState: undefined,
          });
        }
        return;
      }

      console.error(`[example-adapter] Task ${taskId} failed:`, err);
      const t = taskManager.getTask(taskId);
      if (t && !isTerminalStatus(t.status)) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.FAILED,
          endTime: new Date().toISOString(),
          error: `Example error: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
          providerState: undefined,
        });
      }
    } finally {
      clearTimeout(timeoutTimer);
      activeControllers.delete(taskId);
      activeSessions = Math.max(0, activeSessions - 1);
      processRegistry.unregister(taskId);
    }
  }

  async abort(taskId: string, reason?: string): Promise<boolean> {
    const controller = activeControllers.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    for (const [taskId, controller] of activeControllers) {
      console.error(`[example-adapter] Shutting down ${taskId}`);
      controller.abort();
    }
    activeControllers.clear();
    activeSessions = 0;
  }

  getStats(): Record<string, unknown> {
    return {
      activeSessions,
      maxConcurrency: MAX_CONCURRENCY,
      apiKeyConfigured: !!API_KEY,
    };
  }
}
```

### 3. Register in index.ts

Export the adapter from `src/providers/index.ts`:

```typescript
export { ExampleProviderAdapter } from './example-adapter.js';
```

Then register in `src/index.ts` alongside the existing providers:

```typescript
import { ExampleProviderAdapter } from './providers/index.js';

// In the startup block:
providerRegistry.register(new ExampleProviderAdapter());
```

### 4. Add to Provider Type Union

In `src/types.ts`, extend the `Provider` type:

```typescript
export type Provider = 'copilot' | 'claude-cli' | 'codex' | 'example';
```

This enables type-safe `task.provider` assignments throughout the codebase. Until you do this, you will see `as any` casts when setting `provider: 'example'`.

### 5. Configure the Chain

Update the default `PROVIDER_CHAIN` in `src/index.ts`:

```typescript
const chainStr = process.env.PROVIDER_CHAIN || 'copilot,codex,example,!claude-cli';
```

Or leave the default and let users configure via the `PROVIDER_CHAIN` environment variable. The `!` prefix marks a provider as fallback-only (skipped during primary selection, used only when earlier providers fail).

## Common Patterns

### Lazy Imports

All adapters use lazy `await import()` inside methods to prevent circular dependency issues. The provider abstraction layer loads at startup, before service singletons are fully initialized.

```typescript
// CORRECT — lazy import inside method
async spawn(options: ProviderSpawnOptions): Promise<void> {
  const { taskManager } = await import('../services/task-manager.js');
  // ...
}

// WRONG — top-level import creates circular dependency
import { taskManager } from '../services/task-manager.js';
```

The one exception is `require()` for synchronous checks in `checkAvailability()` (see `copilot-adapter.ts`), where async is not possible.

### Concurrency Limiting

Every provider with finite concurrency should track active sessions:

```typescript
let activeSessions = 0;

// In checkAvailability(): reject if at limit
// In spawn(): increment before work, decrement in finally
// In finally: activeSessions = Math.max(0, activeSessions - 1)
```

The `Math.max(0, ...)` prevents underflow from edge cases like double-decrement.

### AbortController Registration

Every provider must register an `AbortController` with `processRegistry` for the kill escalation chain (`SIGTERM` -> wait 3s -> `SIGKILL`):

```typescript
processRegistry.register({
  taskId,
  abortController,
  registeredAt: Date.now(),
  label: 'my-provider-session',
});
```

And unregister in the `finally` block:

```typescript
processRegistry.unregister(taskId);
```

### Terminal State Checks After Await

After every `await` that may yield for a significant time, re-fetch the task and check terminal status. The task may have been cancelled by another code path while waiting.

```typescript
for await (const event of stream) {
  const task = taskManager.getTask(taskId);
  if (!task || isTerminalStatus(task.status)) break;
  // ... process event
}
```

### Timer .unref()

All `setTimeout`/`setInterval` calls must chain `.unref()` to prevent blocking Node.js process exit during shutdown:

```typescript
const timer = setTimeout(() => { ... }, timeout);
timer.unref();
```

### Mode Suffix Prompts

Append the mode-specific behavioral prompt to support `fleet`, `plan`, and `autopilot` modes:

```typescript
const { getModeSuffixPrompt } = await import('../config/mode-prompts.js');
const modeSuffix = getModeSuffixPrompt(mode);
const finalPrompt = modeSuffix ? `${prompt}\n\n${modeSuffix}` : prompt;
```

## Anti-Patterns to Avoid

**Never use `console.log`.** All logging must go through `console.error` (stderr). A single `console.log` corrupts the MCP STDIO JSON-RPC framing and breaks all connected clients.

**Never create the task inside the adapter.** Task creation happens in `shared-spawn.ts` before the provider is called. The adapter receives a `taskId` for an existing PENDING task and is responsible only for RUNNING -> COMPLETED/FAILED.

**Never spread-replace task state.** Use `taskManager.updateTask()` (which does `Object.assign`) to preserve the object reference in the Map. Spread creates a new object that breaks `appendOutput()` references.

```typescript
// WRONG
this.tasks.set(id, { ...task, status: TaskStatus.COMPLETED });

// CORRECT
taskManager.updateTask(taskId, { status: TaskStatus.COMPLETED });
```

**Never throw from spawn().** Errors must be caught and reflected as `TaskStatus.FAILED` on the task. The `shared-spawn.ts` caller does have a `.catch()` that triggers fallback, but the adapter should handle its own errors cleanly.

**Never block checkAvailability().** This method is called synchronously during provider selection. It must return immediately. Do not make network calls or await promises. If you need async checks, do them in `spawn()` and fail the task there.

**Never forget the finally block.** Every spawn must clean up: clear timers, delete abort controllers, decrement concurrency counters, unregister from process registry. Missing cleanup causes resource leaks and phantom concurrency limits.
