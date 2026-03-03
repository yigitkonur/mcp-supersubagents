# 08 — Migration Guide

What changed in the provider abstraction refactor, and what downstream code needs to update.

## Summary of Changes

The refactor replaced hardcoded Copilot-first-Claude-fallback logic with a generic provider abstraction layer. Any AI backend that implements `ProviderAdapter` can now participate in the provider chain. The Codex SDK was added as the first new provider using this abstraction.

## Files Created

| File | Purpose |
|---|---|
| `src/providers/types.ts` | Core interfaces: `ProviderAdapter`, `ProviderCapabilities`, `ProviderSpawnOptions`, `AvailabilityResult`, `FallbackRequest`, `ChainEntry` |
| `src/providers/registry.ts` | `ProviderRegistry` singleton — registration, chain configuration, provider selection, fallback selection |
| `src/providers/copilot-adapter.ts` | `CopilotProviderAdapter` — wraps existing sdk-spawner/session infrastructure |
| `src/providers/claude-adapter.ts` | `ClaudeProviderAdapter` — wraps existing claude-code-runner |
| `src/providers/codex-adapter.ts` | `CodexProviderAdapter` — full @openai/codex-sdk integration |
| `src/providers/fallback-handler.ts` | `triggerFallback()` — provider-agnostic fallback that walks the chain |
| `src/providers/copilot-session-runner.ts` | Bridge between `ProviderAdapter.spawn()` and existing `executeWaitingTask()` |
| `src/providers/index.ts` | Public API barrel export |

## Files Modified

| File | Changes |
|---|---|
| `src/types.ts` | `Provider` union: added `'codex'`. `FallbackReason`: changed from enum to `string` type. Added `providerState` field to `TaskState`. |
| `src/tools/shared-spawn.ts` | Task creation moved here (was inside `sdk-spawner.ts`). Uses `providerRegistry.selectProvider()` for dispatch. Calls `triggerFallback()` on spawn errors. |
| `src/index.ts` | Startup registers all three providers and configures chain from `PROVIDER_CHAIN` env var. |
| `src/services/sdk-spawner.ts` | `triggerClaudeFallback()` calls now route through `triggerFallback()`. Exports `executeWaitingTask()` for use by `copilot-session-runner.ts`. |
| `src/services/sdk-session-adapter.ts` | Fallback triggers now call `triggerFallback()` instead of the old direct Claude fallback. |

## Files Deleted

| File | Replacement |
|---|---|
| `src/services/fallback-orchestrator.ts` | `src/providers/fallback-handler.ts` |
| `src/services/exhaustion-fallback.ts` | `src/providers/fallback-handler.ts` + `providerRegistry.isFallbackEnabled()` |

## Key Behavioral Changes

### Task Creation Moved to shared-spawn.ts

Previously, each provider created its own task via `taskManager.createTask()` inside `spawnCopilotTask()` or `runClaudeCodeSession()`. Now task creation is centralized in `shared-spawn.ts`:

```typescript
// shared-spawn.ts — provider-agnostic task creation
const task = taskManager.createTask(finalPrompt, cwd, model, {
  dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
  labels: labels.length > 0 ? labels : undefined,
  provider: selection.provider.id as any,
  timeout,
  mode,
});
```

The provider receives a `taskId` for an existing PENDING task and is responsible only for RUNNING -> COMPLETED/FAILED transitions.

**Migration note:** If you had code that called `spawnCopilotTask()` directly, it still works for Copilot-specific use cases (e.g., `sendMessage` session resume). For new generic spawns, use `handleSharedSpawn()` or the provider registry.

### session -> providerState Field Rename

The `TaskState.session` field (which held opaque SDK session references) was renamed to `providerState`:

```typescript
// Before
interface TaskState {
  session?: Record<string, unknown>;
}

// After
interface TaskState {
  /** Opaque per-provider state (non-serializable, stripped during persistence) */
  providerState?: Record<string, unknown>;
}
```

**Migration note:** Update any code that reads or writes `task.session` to use `task.providerState`. The persistence layer strips this field (it holds non-serializable SDK objects).

### FallbackReason Opened to String Type

Previously, `FallbackReason` was a closed enum with values like `'copilot_accounts_exhausted'` and `'copilot_rate_limited'`. It is now an open string type:

```typescript
// Before
export type FallbackReason = 'copilot_accounts_exhausted' | 'copilot_rate_limited' | ...;

// After
/** Open string type — any provider can define its own fallback reasons */
export type FallbackReason = string;
```

**Migration note:** Code that pattern-matches on specific `FallbackReason` values still works. New providers can define their own reason strings without modifying the type.

### Provider Type Union Includes 'codex'

```typescript
// Before
export type Provider = 'copilot' | 'claude-cli';

// After
export type Provider = 'copilot' | 'claude-cli' | 'codex';
```

**Migration note:** Any `switch` statements or type narrowing on `Provider` should add a `'codex'` case. The `default` case should handle unknown providers gracefully for forward compatibility.

### triggerClaudeFallback -> triggerFallback

The hardcoded `triggerClaudeFallback()` function (which always fell back to Claude) is replaced by `triggerFallback()` which walks the provider chain:

```typescript
// Before (in sdk-session-adapter.ts, sdk-spawner.ts)
import { triggerClaudeFallback } from '../services/fallback-orchestrator.js';
triggerClaudeFallback(taskId, 'copilot_accounts_exhausted');

// After
import { triggerFallback } from '../providers/fallback-handler.js';
triggerFallback({
  taskId,
  failedProviderId: 'copilot',
  reason: 'copilot_accounts_exhausted',
  errorMessage: 'All PAT tokens exhausted',
  cwd: task.cwd,
});
```

The new `triggerFallback()` uses `providerRegistry.selectFallback(failedProviderId)` to find the next available provider after the failed one in the chain. It respects the `PROVIDER_CHAIN` ordering.

**Migration note:** Replace all `triggerClaudeFallback()` calls with `triggerFallback()` using the `FallbackRequest` interface. The `failedProviderId` parameter determines where in the chain to start looking for a fallback.

### Deleted: fallback-orchestrator.ts and exhaustion-fallback.ts

These two files contained the hardcoded Copilot-to-Claude fallback logic:

- `fallback-orchestrator.ts` — orchestrated the actual Claude session startup on fallback
- `exhaustion-fallback.ts` — provided `isFallbackEnabled()` and `triggerExhaustionFallback()`

Both are replaced by:
- `src/providers/fallback-handler.ts` — `triggerFallback()` and `isFallbackEnabled()`
- `src/providers/registry.ts` — `providerRegistry.selectFallback()` and `providerRegistry.isFallbackEnabled()`

**Migration note:** Update imports. If you imported from either deleted file, switch to `../providers/fallback-handler.js` or `../providers/index.js`.

## New Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDER_CHAIN` | `copilot,codex,!claude-cli` | Comma-separated provider chain. `!` prefix = fallback-only. |
| `OPENAI_API_KEY` | (unset) | API key for Codex SDK |
| `CODEX_API_KEY` | (unset) | Alternative API key for Codex SDK |
| `CODEX_MODEL` | `o4-mini` | Default Codex model |
| `CODEX_PATH` | (auto) | Override Codex CLI binary path |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex sandbox mode |
| `CODEX_APPROVAL_POLICY` | `never` | Codex approval policy |
| `MAX_CONCURRENT_CODEX_SESSIONS` | `5` | Max parallel Codex sessions |
| `DISABLE_CODEX_FALLBACK` | `false` | Disable Codex in availability checks |

## Backward Compatibility

- `DISABLE_CLAUDE_CODE_FALLBACK` still works — it disables Claude in `checkAvailability()`.
- `GITHUB_PAT_TOKENS` and all PAT token env vars still work — the Copilot adapter checks them through `accountManager`.
- The `spawnCopilotTask()` function still exists in `sdk-spawner.ts` for internal use (session resume in `sendMessage`).
- All existing MCP tool schemas are unchanged. Clients see no difference.
- Task state persisted to disk is compatible. The `providerState` field is stripped during persistence (non-serializable), so old persisted state loads without issues.
