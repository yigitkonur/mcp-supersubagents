# Reference: The Claude Agent SDK Fallback

This document walks through the simpler stream-based fallback provider. Study this as an alternative pattern to the event-driven Copilot provider — especially if your SDK uses a streaming interface.

---

## 1. Overview: Single-File Architecture

The entire Claude provider lives in one file: `src/services/claude-code-runner.ts`. It has no singleton class — just exported functions.

| Function | Purpose |
|----------|---------|
| `runClaudeCodeSession()` | Main entry point — runs a full session |
| `abortClaudeCodeSession()` | Cancel via AbortController |

Compared to Copilot's three-file architecture, this is significantly simpler because:
- No client pooling (each session creates a fresh provider)
- No token rotation (no PAT accounts to rotate)
- No session rebinding (stream is one-shot)
- No event subscription management

## 2. When Claude Gets Activated

The Claude fallback is triggered by `triggerClaudeFallback()` in `src/services/fallback-orchestrator.ts`. Triggers include:

| Trigger | Source |
|---------|--------|
| No PAT tokens configured | `sdk-spawner.ts` — immediate on spawn |
| All accounts rate-limited | `sdk-session-adapter.ts` — after rotation exhaustion |
| Account rotation failed | `sdk-spawner.ts` — in `handleRateLimit()` |
| Non-rotatable error | `sdk-session-adapter.ts` — CLI crash, auth error |
| Unhandled error in Copilot session | `sdk-spawner.ts` — catch block in `runSDKSession()` |

The `task.fallbackAttempted` flag is a single-flight guard — `triggerClaudeFallback()` is a no-op if already `true`.

## 3. `runClaudeCodeSession()` — Full Flow

```typescript
// claude-code-runner.ts
export async function runClaudeCodeSession(
  taskId: string,
  prompt: string,
  cwd: string,
  timeout: number,
  model?: string,
  mode?: AgentMode,
): Promise<void>
```

### Slot Acquisition

```typescript
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_CLAUDE_FALLBACKS || '3', 10);
```

Uses a counting semaphore pattern. If all slots are full, the function waits on a Promise that resolves when a slot opens.

### Model Normalization

```typescript
const resolvedModel = model === 'claude-opus-4.6' ? 'claude-opus-4.6'
                    : model === 'claude-haiku-4.5' ? 'claude-haiku-4.5'
                    : 'claude-sonnet-4.6';
```

### Provider Creation

```typescript
import { claudeCode } from 'ai-sdk-provider-claude-code';

const provider = claudeCode({
  cwd,
  permissionMode: permissionMode as any,
});
```

### AbortController

```typescript
const abortController = new AbortController();
processRegistry.register({
  taskId,
  abortController,
  registeredAt: Date.now(),
  label: 'claude-fallback',
});
```

The `abortClaudeCodeSession()` function triggers `abortController.abort()`.

### Stream Processing

The core loop processes `LanguageModelV3StreamPart` types:

```typescript
const stream = streamText({
  model: provider(resolvedModel),
  prompt: finalPrompt,
  abortSignal: abortController.signal,
  maxSteps: 200,
});

for await (const part of stream.fullStream) {
  switch (part.type) {
    case 'text-start': ...
    case 'text-delta': ...
    case 'text-end': ...
    case 'reasoning-start': ...
    case 'reasoning-delta': ...
    case 'reasoning-end': ...
    case 'tool-input-start': ...
    case 'tool-input-delta': ...
    case 'tool-input-end': ...
    case 'tool-call': ...
    case 'tool-result': ...
    case 'finish': ...
    case 'error': ...
    // ... other types
  }
}
```

### Stream Part Type Table

| Stream Part | Contains | Maps To |
|-------------|----------|---------|
| `text-start` | — | Reset text buffer |
| `text-delta` | `delta: string` | Accumulate in buffer, flush complete lines via `appendOutput` |
| `text-end` | — | Flush remaining buffer |
| `reasoning-start` | — | Reset reasoning buffer |
| `reasoning-delta` | `delta: string` | Accumulate in buffer |
| `reasoning-end` | — | Flush to `appendOutputFileOnly` with `[reasoning]` prefix |
| `tool-input-start` | `toolCallId`, `toolName` | Log tool start via `formatToolStart()` |
| `tool-input-delta` | `delta: string` | Accumulate tool input |
| `tool-input-end` | — | (no-op, wait for tool-call) |
| `tool-call` | `toolCallId`, `toolName`, `args` | Extract context for summarizer |
| `tool-result` | `toolCallId`, `result` | Log tool completion via `formatToolComplete()` |
| `finish` | `finishReason`, `usage` | Log token usage to file |
| `error` | `error` | Log error, check for rate limit |
| `stream-start` | — | (no-op) |
| `source` | `sourceType`, `url` | Log source reference |
| `file` | `mediaType`, `data` | Log file output |
| `tool-approval-request` | — | (no-op in bypass mode) |

### Tool Execution Tracking

The Claude provider tracks tools using the same `tool-summarizer.ts` utilities as the Copilot provider:

```typescript
// On tool-call:
const ctx = extractToolContext(toolName, args);

// On tool-result:
const resultInfo = extractResultInfo(toolName, result);
const summary = formatToolComplete(ctx, { duration, success: true, ...resultInfo });
taskManager.appendOutput(taskId, `[tool] ${summary}`);
```

### Output Formatting

Text output is accumulated line-by-line and flushed only on complete lines (newline character). This prevents partial lines from cluttering the output array:

```typescript
// Accumulate delta
textBuffer += delta;

// Flush complete lines
while (textBuffer.includes('\n')) {
  const idx = textBuffer.indexOf('\n');
  const line = textBuffer.slice(0, idx);
  taskManager.appendOutput(taskId, line);
  textBuffer = textBuffer.slice(idx + 1);
}
```

### Completion and Cleanup

On stream end:
1. Flush remaining text/reasoning buffers
2. Update task to `COMPLETED` or `FAILED`
3. Unregister from `processRegistry`
4. Release concurrency slot

## 4. Differences From the Copilot Provider

| Aspect | Copilot SDK | Claude Agent SDK |
|--------|-------------|------------------|
| **Architecture** | 3 files, singleton classes | 1 file, exported functions |
| **Transport** | PTY-based session, event-driven | Stream-based, `for await` loop |
| **Concurrency** | Unlimited sessions (limited by PTY FDs) | MAX_CONCURRENT=3 slots |
| **Token rotation** | Multi-account round-robin | None (no PAT accounts) |
| **Session resume** | Supported (after rotation) | Not supported (one-shot) |
| **Rate limit recovery** | Rotation + health check + rebind | None (marks as FAILED) |
| **Mode support** | Autopilot RPC + fleet RPC + suffix | `bypassPermissions` + suffix |
| **User input** | `onUserInputRequest` → `questionRegistry` | Not supported |
| **Metrics** | Rich: quotas, tool metrics, sub-agents | Basic: token count, tool count |
| **Cancellation** | `session.abort()` | `abortController.abort()` |
| **Output format** | Same (via tool-summarizer) | Same (via tool-summarizer) |

## 5. Summary: What This Provider Implements

| Responsibility | How |
|----------------|-----|
| Task state: RUNNING | Set at start of `runClaudeCodeSession()` |
| Output streaming | `text-delta` → line-buffered `appendOutput()` |
| Tool tracking | `tool-call`/`tool-result` → `formatToolComplete()` |
| Completion | Stream end → `COMPLETED` |
| Error handling | `error` part or exception → `FAILED` |
| Cancellation | `AbortController` via `processRegistry` |
| Concurrency control | Counting semaphore (MAX_CONCURRENT=3) |
| Metrics | Token count from `finish` parts |

This provider is a good model for a new SDK integration that uses streaming. The key pattern is: iterate the stream, match part types to output/state updates, handle errors gracefully.

---

**Previous:** [05 — Provider Reference: Copilot](./05-provider-reference-copilot.md) · **Next:** [07 — Fallback and Rotation](./07-fallback-and-rotation.md)
