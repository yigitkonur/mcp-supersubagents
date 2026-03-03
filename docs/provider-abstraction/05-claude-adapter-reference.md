# 05 — Claude Adapter Reference

## Overview

`ClaudeProviderAdapter` wraps the existing `claude-code-runner.ts` service through the `ProviderAdapter` interface. It delegates all execution to `runClaudeCodeSession()` and `abortClaudeCodeSession()`, adding no logic of its own beyond capability declaration and availability gating.

**Source:** `src/providers/claude-adapter.ts`
**Delegates to:** `src/services/claude-code-runner.ts`

## Capability Profile

```typescript
const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: false,
  supportsUserInput: false,
  supportsFleetMode: false,
  supportsCredentialRotation: false,
  maxConcurrency: MAX_CONCURRENCY, // default 3
};
```

All capability flags are `false`. The Claude Agent SDK has no session resume, no `ask_user` tool support, no fleet RPC, and no credential rotation. The only behavioral knob is `maxConcurrency`, parsed from `MAX_CONCURRENT_CLAUDE_FALLBACKS`.

## Availability Check

```typescript
checkAvailability(): AvailabilityResult {
  if (process.env.DISABLE_CLAUDE_CODE_FALLBACK === 'true') {
    return {
      available: false,
      reason: 'Claude fallback disabled (DISABLE_CLAUDE_CODE_FALLBACK=true)',
    };
  }
  return { available: true };
}
```

Unlike the Copilot adapter (which checks for PAT tokens) or the Codex adapter (which checks for API keys and concurrency), Claude's availability is binary: either disabled by env var or always available. The actual Claude SDK availability check happens inside `claude-code-runner.ts` at spawn time via `checkClaudeAvailability()`.

## spawn()

```typescript
async spawn(options: ProviderSpawnOptions): Promise<void> {
  const { runClaudeCodeSession } = await import('../services/claude-code-runner.js');
  const { getModeSuffixPrompt } = await import('../config/mode-prompts.js');
  const { taskManager } = await import('../services/task-manager.js');

  const task = taskManager.getTask(options.taskId);
  if (!task) {
    console.error(`[claude-adapter] Task ${options.taskId} not found`);
    return;
  }

  await runClaudeCodeSession(
    options.taskId,
    options.prompt,
    options.cwd,
    options.timeout,
    {
      preferredModel: options.model,
      mode: options.mode,
    },
  );
}
```

Key details:

- **Lazy imports** prevent circular dependencies at module load time. `runClaudeCodeSession` is in `claude-code-runner.ts`, which imports `task-manager.ts`, which can import providers.
- **Task lookup** is a guard — if the task was cancelled between creation in `shared-spawn.ts` and the `setImmediate` callback, bail out.
- The runner handles its own state transitions: PENDING -> RUNNING -> COMPLETED/FAILED. The adapter does not set `status: TaskStatus.RUNNING` — `runClaudeCodeSession` does that internally.
- Mode suffix prompts are appended inside `runClaudeCodeSession`, not in the adapter.

### What runClaudeCodeSession Does

Inside `claude-code-runner.ts`, the function:

1. Acquires a concurrency slot (queue-based, `MAX_CONCURRENT_CLAUDE_FALLBACKS`)
2. Re-checks task terminal status after waiting for the slot
3. Resolves the model via `CLAUDE_FALLBACK_MODEL` env override or the passed model
4. Updates task to RUNNING with `provider: 'claude-cli'`
5. Creates an `AbortController` and registers it with `processRegistry`
6. Calls `claudeCode()` from `ai-sdk-provider-claude-code` to start a streaming session
7. Processes stream parts (text deltas, tool calls, tool results, finish reasons)
8. On completion: updates task to COMPLETED with session metrics
9. On error: updates task to FAILED with `failureContext`

## abort()

```typescript
async abort(taskId: string, reason?: string): Promise<boolean> {
  const { abortClaudeCodeSession } = await import('../services/claude-code-runner.js');
  return abortClaudeCodeSession(taskId, reason ?? 'Task cancelled');
}
```

Delegates to `abortClaudeCodeSession()` which calls `.abort()` on the `AbortController` stored in `activeFallbackControllers` map. Returns `false` if no active controller exists for the task.

## shutdown()

```typescript
async shutdown(): Promise<void> {
  const { abortAllFallbackSessions } = await import('../services/claude-code-runner.js');
  abortAllFallbackSessions('Server shutdown');
}
```

Aborts every active Claude session. Called by `providerRegistry.shutdownAll()` during server exit.

## Why sendMessage Is Not Supported

The `sendMessage` method is not implemented on `ClaudeProviderAdapter`. The Claude Agent SDK (`claude` CLI via `ai-sdk-provider-claude-code`) does not support session resume — each invocation is a standalone execution. There is no session ID to resume from, and no mechanism to send follow-up messages to an existing process.

When `send_message` is called on a Claude-provider task, the tool handler checks `supportsSessionResume` (which is `false`) and returns an error to the MCP client.

## Configuration Environment Variables

| Variable | Default | Effect |
|---|---|---|
| `DISABLE_CLAUDE_CODE_FALLBACK` | `false` | Disables Claude entirely in `checkAvailability()` |
| `CLAUDE_FALLBACK_MODEL` | `sonnet` | Override model for all Claude sessions |
| `CLAUDE_FALLBACK_PERMISSION_MODE` | `bypassPermissions` | Permission mode passed to the SDK |
| `CLAUDE_FALLBACK_TOOL_POLICY` | `allow_all` | `allow_all` or `safe` (safe blocks dangerous bash commands) |
| `CLAUDE_FALLBACK_ALLOWED_TOOLS` | `*` (all) | CSV of allowed tool names |
| `CLAUDE_FALLBACK_DISALLOWED_TOOLS` | (unset) | CSV of disallowed tool names (overrides allowed) |
| `CLAUDE_FALLBACK_MAX_BUDGET_USD` | (unset) | Maximum spend per session |
| `MAX_CONCURRENT_CLAUDE_FALLBACKS` | `3` | Max parallel Claude sessions |
| `DEBUG_CLAUDE_FALLBACK` | `false` | Verbose stream-part logging to stderr |

## Stats

```typescript
getStats(): Record<string, unknown> {
  return {
    maxConcurrency: MAX_CONCURRENCY,
    disabled: process.env.DISABLE_CLAUDE_CODE_FALLBACK === 'true',
  };
}
```

Minimal stats. The Claude runner does not expose active session count through a public API — only whether the provider is disabled and its configured concurrency limit.
