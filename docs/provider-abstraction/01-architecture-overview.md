# Provider Abstraction Layer: Architecture Overview

## Purpose

The provider abstraction layer decouples task creation from task execution. Before this layer, the spawn flow was hardwired: Copilot SDK as primary, Claude Agent SDK as a special-cased fallback. The abstraction introduces a `ProviderAdapter` interface that any AI backend can implement, a `ProviderRegistry` singleton that manages selection and fallback ordering, and a generic `triggerFallback()` that walks the chain without knowing which providers exist.

## System Flow

```
                         MCP Client
                             |
                        spawn_agent
                             |
                    +--------v--------+
                    |  shared-spawn.ts |
                    |                  |
                    |  1. Zod parse    |
                    |  2. validateBrief|
                    |  3. assemblePrompt|
                    |  4. applyTemplate|
                    |  5. selectProvider|----> providerRegistry.selectProvider()
                    |  6. createTask   |        walks chain, returns first available
                    |  7. setImmediate |
                    +--------+---------+
                             |
                    provider.spawn(options)
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v--------+
     |  copilot    |  |   codex     |  |  claude-cli  |
     |  adapter    |  |   adapter   |  |  adapter     |
     +------+------+  +------+------+  +------+------+
            |                |                |
     copilot-session   @openai/codex-sdk  claude-code-
     -runner.ts        (Codex SDK)        runner.ts
            |                |                |
     executeWaitingTask  thread.runStreamed  runClaudeCode
     (sdk-spawner.ts)    (async generator)  Session
            |                |                |
            +--------+-------+--------+-------+
                     |                |
              taskManager.updateTask  taskManager.appendOutput
                     |
                COMPLETED | FAILED
                     |
              (on failure)
                     |
              triggerFallback()
                     |
              providerRegistry.selectFallback(failedId)
                     |
              next provider in chain
```

## Separation of Concerns

**Task creation** happens in `shared-spawn.ts` and is provider-agnostic:

1. Parse and validate arguments (Zod schema)
2. Validate brief (prompt length, context files)
3. Assemble prompt with context file contents
4. Apply matryoshka template (base `.mdx` + overlay)
5. Select a provider via `providerRegistry.selectProvider()`
6. Create the `TaskState` via `taskManager.createTask()`
7. Return the task ID to the MCP client immediately

**Task execution** is delegated to the selected provider via `provider.spawn(options)` inside a `setImmediate` callback. The provider is responsible for driving the task from `PENDING` through `RUNNING` to `COMPLETED` or `FAILED`. The spawn caller does not wait for completion.

From `src/tools/shared-spawn.ts`:

```typescript
setImmediate(() => {
  const current = taskManager.getTask(taskId);
  if (!current || isTerminalStatus(current.status)) return;

  selectedProvider.spawn({
    taskId,
    prompt: finalPrompt,
    cwd,
    model,
    timeout,
    mode,
    reasoningEffort: params.reasoning_effort,
    labels: labels.length > 0 ? labels : undefined,
    taskType: config.taskType || 'super-coder',
  }).catch((err) => {
    // Attempt fallback to next provider in chain
    triggerFallback({
      taskId,
      failedProviderId: selectedProvider.id,
      reason: `${selectedProvider.id}_spawn_error`,
      errorMessage: err instanceof Error ? err.message : String(err),
      cwd,
      promptOverride: finalPrompt,
    });
  });
});
```

## Registered Providers

| ID | Class | Backend | Capabilities |
|---|---|---|---|
| `copilot` | `CopilotProviderAdapter` | GitHub Copilot SDK (PTY-based, streaming) | Session resume, user input, fleet mode, credential rotation, unlimited concurrency |
| `codex` | `CodexProviderAdapter` | OpenAI Codex SDK (`@openai/codex-sdk`) | Configurable concurrency (default 5), sandbox modes |
| `claude-cli` | `ClaudeProviderAdapter` | Claude Agent SDK (`claude` CLI) | Configurable concurrency (default 3), bypass permissions |

## Provider Chain

The chain determines selection order and fallback behavior. It is configured via the `PROVIDER_CHAIN` environment variable.

**Default chain:** `copilot,codex,!claude-cli`

This means:
- `copilot` is tried first for primary selection
- `codex` is tried second if copilot is unavailable
- `claude-cli` is fallback-only (the `!` prefix) -- skipped during primary selection, only used when a provider fails mid-task

The chain is parsed at startup in `src/index.ts`:

```typescript
providerRegistry.register(new CopilotProviderAdapter());
providerRegistry.register(new CodexProviderAdapter());
providerRegistry.register(new ClaudeProviderAdapter());

const chainStr = process.env.PROVIDER_CHAIN || 'copilot,codex,!claude-cli';
providerRegistry.configureChain(parseChainString(chainStr));
```

### Chain Examples

| `PROVIDER_CHAIN` | Behavior |
|---|---|
| `copilot,codex,!claude-cli` | Default. Copilot primary, Codex second, Claude fallback-only. |
| `codex,copilot` | Codex primary, Copilot second, no fallback-only providers. |
| `claude-cli` | Claude as the only provider, no fallback. |
| `copilot,!codex,!claude-cli` | Copilot only for primary. Codex and Claude both fallback-only. |

## Key Files

| File | Role |
|---|---|
| `src/providers/types.ts` | All interfaces: `ProviderAdapter`, `ProviderCapabilities`, `ProviderSpawnOptions`, `AvailabilityResult`, `FallbackRequest`, `ChainEntry` |
| `src/providers/registry.ts` | `ProviderRegistry` singleton, `parseChainString()` |
| `src/providers/copilot-adapter.ts` | Copilot SDK adapter |
| `src/providers/claude-adapter.ts` | Claude Agent SDK adapter |
| `src/providers/codex-adapter.ts` | OpenAI Codex SDK adapter |
| `src/providers/fallback-handler.ts` | `triggerFallback()`, `isFallbackEnabled()` |
| `src/providers/copilot-session-runner.ts` | Bridge between adapter interface and `executeWaitingTask()` |
| `src/providers/index.ts` | Public API re-exports |
| `src/tools/shared-spawn.ts` | Task creation + provider dispatch |
| `src/index.ts` | Provider registration at startup |
