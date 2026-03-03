# Cookbook: Adding a New Provider Step-by-Step

This document is an actionable walkthrough for adding a new AI provider to the system. It uses "OpenAI Codex" as a running example but applies to any SDK.

---

## Prerequisites

Read these docs first (in order):
- [01 — System Overview](./01-system-overview.md) — What the system does, where your code fits
- [02 — Task Lifecycle](./02-task-lifecycle.md) — The state machine your provider must drive
- [03 — Task Manager Contract](./03-task-manager-contract.md) — The API you'll call
- [04 — Spawn Pipeline](./04-spawn-pipeline.md) — Where you plug in
- [11 — Concurrency and Safety](./11-concurrency-and-safety.md) — Patterns you must follow

Reference as needed:
- [05](./05-provider-reference-copilot.md) / [06](./06-provider-reference-claude.md) — Existing provider implementations
- [07](./07-fallback-and-rotation.md) — If integrating with fallback chain
- [08](./08-supporting-services.md) — Supporting services to register with
- [09](./09-session-metrics-and-observability.md) — Metrics to populate
- [10](./10-mode-system-and-templates.md) — Mode suffix prompts

## Step 1: Extend `Provider` Type

```typescript
// src/types.ts:4
export type Provider = 'copilot' | 'claude-cli' | 'openai-codex';
```

This is a union type used in `TaskState.provider` to identify which backend ran a task.

## Step 2: Add `FallbackReason` Entries (If Applicable)

If your provider can trigger fallbacks, add reason strings:

```typescript
// Used in FallbackRequest.reason (free-form string)
// Convention: 'provider_reason_detail'
'openai_codex_rate_limited'
'openai_codex_error'
'openai_codex_accounts_exhausted'
```

## Step 3: Create Provider Runner

Create `src/services/openai-codex-runner.ts`:

```typescript
import { taskManager } from './task-manager.js';
import { processRegistry } from './process-registry.js';
import { TaskStatus, isTerminalStatus, type AgentMode } from '../types.js';
import { getModeSuffixPrompt } from '../config/mode-prompts.js';
import {
  extractToolContext,
  extractResultInfo,
  formatToolStart,
  formatToolComplete,
} from '../utils/tool-summarizer.js';

const MAX_CONCURRENT = 5;
let activeCount = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  activeCount++;
}

function releaseSlot(): void {
  activeCount--;
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    next();
  }
}

export async function runOpenAICodexSession(
  taskId: string,
  prompt: string,
  cwd: string,
  timeout: number,
  model?: string,
  mode?: AgentMode,
): Promise<void> {
  await acquireSlot();

  const abortController = new AbortController();

  // Register with process registry for cancellation support
  processRegistry.register({
    taskId,
    abortController,
    registeredAt: Date.now(),
    label: 'openai-codex',
  });

  try {
    // Mark task as running
    taskManager.updateTask(taskId, {
      status: TaskStatus.RUNNING,
      provider: 'openai-codex',
    });

    // Apply mode suffix prompt
    const modeSuffix = getModeSuffixPrompt(mode ?? 'fleet');
    const finalPrompt = modeSuffix ? prompt + modeSuffix : prompt;

    // ── Initialize your SDK here ──
    // const client = new OpenAICodexClient({ apiKey: process.env.OPENAI_API_KEY });
    // const stream = client.run({ prompt: finalPrompt, cwd, model });

    let turnCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // ── Process your SDK's output ──
    // for await (const event of stream) {
    //   // Check for cancellation after each event
    //   const task = taskManager.getTask(taskId);
    //   if (!task || isTerminalStatus(task.status)) break;
    //
    //   switch (event.type) {
    //     case 'text':
    //       taskManager.appendOutput(taskId, event.content);
    //       break;
    //     case 'tool_start':
    //       const ctx = extractToolContext(event.toolName, event.args);
    //       taskManager.appendOutputFileOnly(taskId, `[tool] ${formatToolStart(ctx)}`);
    //       break;
    //     case 'tool_end':
    //       const resultInfo = extractResultInfo(event.toolName, event.result);
    //       const summary = formatToolComplete(ctx, { duration: event.durationMs, success: true, ...resultInfo });
    //       taskManager.appendOutput(taskId, `[tool] ${summary}`);
    //       break;
    //     case 'turn_start':
    //       turnCount++;
    //       taskManager.appendOutput(taskId, `--- Turn ${turnCount} ---`);
    //       break;
    //     case 'usage':
    //       totalInputTokens += event.inputTokens;
    //       totalOutputTokens += event.outputTokens;
    //       taskManager.appendOutputFileOnly(taskId, `[usage] in=${event.inputTokens} out=${event.outputTokens}`);
    //       break;
    //     case 'error':
    //       taskManager.appendOutput(taskId, `[error] ${event.message}`);
    //       break;
    //   }
    //
    //   // Update metrics periodically
    //   taskManager.updateTask(taskId, {
    //     sessionMetrics: {
    //       turnCount,
    //       totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    //       quotas: {},
    //       toolMetrics: {},
    //       activeSubagents: [],
    //       completedSubagents: [],
    //     },
    //   });
    // }

    // Check if task was cancelled during execution
    const finalTask = taskManager.getTask(taskId);
    if (!finalTask || isTerminalStatus(finalTask.status)) {
      return; // Already handled
    }

    // Mark as completed
    taskManager.updateTask(taskId, {
      status: TaskStatus.COMPLETED,
      endTime: new Date().toISOString(),
      exitCode: 0,
      session: undefined,
    });

    console.error(`[openai-codex] Task ${taskId} completed`);

  } catch (error) {
    // Check if already handled (cancelled, timed out)
    const task = taskManager.getTask(taskId);
    if (task && !isTerminalStatus(task.status)) {
      const message = error instanceof Error ? error.message : String(error);
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: message,
        exitCode: 1,
        session: undefined,
      });
      console.error(`[openai-codex] Task ${taskId} failed: ${message}`);
    }
  } finally {
    processRegistry.unregister(taskId);
    releaseSlot();
  }
}

export function abortOpenAICodexSession(taskId: string): void {
  processRegistry.killTask(taskId);
}
```

## Step 4: Create Provider Spawner

Either create a dedicated spawner or add routing to the existing pipeline.

**Option A: Dedicated function in a new file** (`src/services/openai-codex-spawner.ts`):

```typescript
import { taskManager } from './task-manager.js';
import { resolveModel } from '../models.js';
import { clientContext } from './client-context.js';
import { TaskStatus, isTerminalStatus, type SpawnOptions } from '../types.js';
import { TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';

export async function spawnOpenAICodexTask(options: SpawnOptions): Promise<string> {
  const cwd = options.cwd || clientContext.getDefaultCwd();
  const model = resolveModel(options.model, options.taskType);
  const timeout = options.timeout ?? TASK_TIMEOUT_DEFAULT_MS;

  const task = taskManager.createTask(options.prompt, cwd, model, {
    dependsOn: options.dependsOn,
    labels: options.labels,
    provider: 'openai-codex',
    timeout,
    mode: options.mode,
  });

  if (task.status === TaskStatus.WAITING) {
    return task.id;
  }

  const taskId = task.id;

  // Execute asynchronously — return task ID immediately
  setImmediate(() => {
    const current = taskManager.getTask(taskId);
    if (!current || isTerminalStatus(current.status)) return;

    // Lazy import to avoid circular dependencies
    import('./openai-codex-runner.js').then(({ runOpenAICodexSession }) => {
      runOpenAICodexSession(taskId, options.prompt, cwd, timeout, model, options.mode)
        .catch((err) => {
          console.error(`[openai-codex-spawner] Task ${taskId} error:`, err);
        });
    });
  });

  return taskId;
}
```

**Option B: Add routing to `shared-spawn.ts`** (simpler, fewer files):

```typescript
// In shared-spawn.ts, replace the dispatch call:
const provider = process.env.MCP_PROVIDER || 'copilot';

if (provider === 'openai-codex') {
  const { spawnOpenAICodexTask } = await import('../services/openai-codex-spawner.js');
  return spawnOpenAICodexTask(spawnOptions);
}

return spawnCopilotTask(spawnOptions);
```

## Step 5: Wire Into Spawn Pipeline

Modify `src/tools/shared-spawn.ts` to support provider routing. The simplest approach is environment-variable-based selection:

```typescript
// At the dispatch point in shared-spawn.ts
function selectProvider(): string {
  return process.env.MCP_PROVIDER || 'copilot';
}
```

Or per-request selection by adding `provider` to the `SpawnAgentSchema` in `spawn-agent.ts`.

## Step 6: Integrate Fallback Chain

If your provider should participate in the fallback chain:

**As primary (replacing Copilot):**
- Route all spawns to your provider
- On failure, call `triggerClaudeFallback()` from `src/services/fallback-orchestrator.ts`

**As middle (between Copilot and Claude):**
- Modify `fallback-orchestrator.ts`:

```typescript
export async function triggerClaudeFallback(taskId: string, request: FallbackRequest): Promise<boolean> {
  // Try your provider first
  if (isOpenAICodexAvailable()) {
    const started = await triggerOpenAICodexFallback(taskId, request);
    if (started) return true;
  }
  // Then fall through to Claude
  // ... existing Claude fallback code ...
}
```

## Step 7: Handle Modes

Apply mode suffix prompts to your final prompt:

```typescript
import { getModeSuffixPrompt } from '../config/mode-prompts.js';

const modeSuffix = getModeSuffixPrompt(mode ?? 'fleet');
const finalPrompt = modeSuffix ? prompt + modeSuffix : prompt;
```

If your SDK supports native parallel execution:

```typescript
if (mode === 'fleet' && client.supportsParallelExecution) {
  client.enableParallelMode();
}
```

## Step 8: Handle Questions (ask_user)

If your SDK supports user input:

```typescript
import { questionRegistry } from './question-registry.js';

// Wire into your SDK's ask_user callback:
sdk.onAskUser(async (question, choices) => {
  const response = await questionRegistry.register(
    taskId, sessionId, question, choices, true
  );
  return response.answer;
});
```

If your SDK doesn't support user input, skip this — the registry is optional.

## Step 9: Populate Metrics

**Required (minimum):**

```typescript
taskManager.updateTask(taskId, {
  sessionMetrics: {
    turnCount,
    totalTokens: { input: totalInput, output: totalOutput },
    quotas: {},
    toolMetrics: {},
    activeSubagents: [],
    completedSubagents: [],
  },
});
```

**Recommended:** Track tool metrics:

```typescript
const toolMetrics: Record<string, ToolMetrics> = {};
// On tool start:
toolStartTimes.set(toolCallId, Date.now());
// On tool end:
const duration = Date.now() - toolStartTimes.get(toolCallId);
if (!toolMetrics[toolName]) {
  toolMetrics[toolName] = { toolName, executionCount: 0, successCount: 0, failureCount: 0, totalDurationMs: 0 };
}
toolMetrics[toolName].executionCount++;
toolMetrics[toolName].totalDurationMs += duration;
```

**Nice-to-have:** `CompletionMetrics` on completion, `QuotaInfo` from SDK API.

## Step 10: Environment Variables & Config

Add to `CLAUDE.md`:

```markdown
### OpenAI Codex

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `MCP_PROVIDER` | `copilot` | Set to `openai-codex` to use as primary |
| `MAX_CONCURRENT_OPENAI_SESSIONS` | `5` | Max simultaneous sessions |
```

Add to `src/config/timeouts.ts` if you need provider-specific timeouts.

## Step 11: Update Build

If your provider requires a new npm package:

```bash
pnpm add openai-codex-sdk
```

The build script (`pnpm build`) should work without changes since `tsc` will compile your new `.ts` files automatically. If you add new non-TS assets, update the copy commands.

## Step 12: Test

### Build Verification

```bash
pnpm build
# Should complete with no errors (--noEmitOnError false tolerates type warnings)
```

### Protocol Verification

```bash
pnpm mcp:smoke
# Verifies STDIO MCP framing is unbroken
```

### Manual Testing Checklist

- [ ] `spawn_agent` with your provider → task enters RUNNING
- [ ] Task completes → status COMPLETED, output has content
- [ ] `send_message` to running task → response received
- [ ] `cancel_task` on running task → status CANCELLED
- [ ] `answer_question` (if your SDK supports ask_user) → question resolved
- [ ] Error handling → task enters FAILED with error message
- [ ] Timeout → task enters TIMED_OUT
- [ ] Mode suffix → fleet/plan/autopilot prompts applied
- [ ] Metrics → `sessionMetrics` populated in task resource
- [ ] Concurrent tasks → no interference between tasks
- [ ] `console.error` only → no stdout output (verify with `node build/index.js 2>/dev/null`)

## Anti-Patterns to Avoid

- **`console.log`** — Corrupts MCP framing. Always `console.error`.
- **Spread instead of Object.assign** — `{ ...task, status }` breaks output references. Always use `taskManager.updateTask()`.
- **Missing terminal state check after await** — Task may have been cancelled. Always re-fetch.
- **Blocking spawn** — `return await runSession()` blocks the MCP tool call. Use `setImmediate`.
- **Non-idempotent cleanup** — Multiple error paths may call cleanup. Guard with a boolean flag.
- **Timers without `.unref()`** — Prevents graceful process exit.
- **Logging raw tokens** — PAT tokens must never appear in logs.
- **Direct Map replacement** — `this.tasks.set(id, newObject)` breaks references. Use `Object.assign`.
- **Synchronous file I/O in event handlers** — Blocks the event loop, starves other tasks.
- **Ignoring `isTerminalStatus()`** — Updating a completed task is silently rejected but indicates a logic bug.

## Complete File Modification Checklist

| File | Change | Reason |
|------|--------|--------|
| `src/types.ts` | Add `'openai-codex'` to `Provider` type | Type safety |
| `src/services/openai-codex-runner.ts` | **New file** — session runner | Core provider logic |
| `src/services/openai-codex-spawner.ts` | **New file** — task spawner | Entry point with `setImmediate` |
| `src/tools/shared-spawn.ts` | Add provider routing | Wire your provider into the pipeline |
| `src/services/fallback-orchestrator.ts` | Add fallback trigger (optional) | If participating in fallback chain |
| `CLAUDE.md` | Document env vars | Developer reference |
| `package.json` | Add SDK dependency (if needed) | Build |

**Files you should NOT modify:**
- `src/services/task-manager.ts` — Provider-agnostic
- `src/templates/` — Provider-agnostic
- `src/utils/brief-validator.ts` — Provider-agnostic
- `src/tools/spawn-agent.ts` — Only if adding new schema fields
- `src/index.ts` — Only if adding new MCP tools

---

**Previous:** [11 — Concurrency and Safety](./11-concurrency-and-safety.md)
