# Fallback Orchestration and Token Rotation

This document covers the resilience layer that keeps tasks running when accounts hit rate limits. A new provider may need to integrate with this chain or implement its own rotation strategy.

---

## 1. The Provider Fallback Chain

```
Task spawned
    │
    ▼
Check PAT tokens available?
    │
    ├── YES → Copilot SDK Session (primary)
    │           │
    │           ├── Rate limit (429/5xx)
    │           │   └── Rotate PAT token (up to 10 attempts)
    │           │       ├── Rotation success → new session, rebind
    │           │       └── All exhausted
    │           │           ├── Claude fallback enabled?
    │           │           │   ├── YES → Claude Agent SDK
    │           │           │   └── NO → FAILED
    │           │           └── (fallbackAttempted guard prevents re-entry)
    │           │
    │           ├── Non-rotatable error (CLI crash, auth failure)
    │           │   ├── Claude fallback enabled? → YES → Claude Agent SDK
    │           │   └── NO → FAILED
    │           │
    │           └── Quota < 1% → Proactive rotation before hard limit
    │
    ├── NO → Claude fallback enabled?
    │       ├── YES → Claude Agent SDK (immediate)
    │       └── NO → FAILED
    │
    └── ┌─────────────────────────────────────────────────┐
        │ YOUR NEW PROVIDER FITS HERE:                     │
        │ Option A: Replace Copilot as primary             │
        │ Option B: Between Copilot and Claude             │
        │ Option C: After Claude as additional fallback    │
        └─────────────────────────────────────────────────┘
```

## 2. Account Manager

**File:** `src/services/account-manager.ts` — Singleton: `accountManager`

### Token Discovery

Tokens are discovered in priority order (first match wins):

| Priority | Env Variable | Format |
|----------|-------------|--------|
| 1 | `GITHUB_PAT_TOKENS` | Comma-separated list |
| 2 | `GITHUB_PAT_TOKEN_1` through `GITHUB_PAT_TOKEN_100` | Numbered individual vars |
| 3 | `GH_PAT_TOKEN` | Comma-separated fallback |
| 4 | `GITHUB_TOKEN` / `GH_TOKEN` | Single token |

Maximum 100 tokens. Extras are silently dropped.

### Round-Robin Rotation

```typescript
// account-manager.ts
rotateToNext(reason: string, fromTokenIndex?: number): RotationResult
```

- Cycles through tokens in order: A → B → C → A → ...
- The `fromTokenIndex` parameter prevents thundering-herd misattribution (only rotates if the current index matches the reported failed index)
- Returns `{ success: boolean; tokenIndex?: number; allExhausted?: boolean; error?: string }`

### Cooldown and Auto-Heal

| Mechanism | Duration | Purpose |
|-----------|----------|---------|
| Failure cooldown | 60 seconds | Failed tokens are skipped for 60s |
| Stale failure auto-heal | 5 minutes | Tokens failed > 5min ago are retried |
| Reset date support | Variable | Uses API-reported quota reset time |

```typescript
getCurrentToken(): string | undefined     // Returns undefined if all on cooldown
shouldRotate(statusCode?: number): boolean  // True for 429, 500, 502, 503, 504
getMaskedCurrentToken(): string            // Safe for logging: ghp_***abc
```

### State Export

```typescript
exportCooldownState(): CooldownState     // For MCP status resource
importCooldownState(state: CooldownState) // For crash recovery
```

## 3. Exhaustion Decision

**File:** `src/services/exhaustion-fallback.ts`

Two functions control the fallback decision:

```typescript
export function shouldFallbackToClaudeCode(rotationResult: RotationResult): boolean {
  if (!isFallbackEnabled()) return false;
  return rotationResult.allExhausted === true;
}

export function isFallbackEnabled(): boolean {
  return process.env.DISABLE_CLAUDE_CODE_FALLBACK !== 'true';
}
```

The logic is deliberately minimal — the decision is binary: either all accounts are exhausted and fallback is enabled, or not.

## 4. Fallback Orchestrator

**File:** `src/services/fallback-orchestrator.ts`

### `triggerClaudeFallback()`

```typescript
export async function triggerClaudeFallback(
  taskId: string,
  request: FallbackRequest
): Promise<boolean>
```

**The single-flight guard:**

```typescript
const task = taskManager.getTask(taskId);
if (task.fallbackAttempted) return false;  // Already attempted — no-op
taskManager.updateTask(taskId, { fallbackAttempted: true });
```

This prevents multiple concurrent error handlers from each triggering a separate fallback session.

### `FallbackRequest` Interface

```typescript
interface FallbackRequest {
  reason: string;              // e.g., 'copilot_accounts_exhausted'
  errorMessage?: string;
  session?: CopilotSession;    // Old session for cleanup
  cwd?: string;
  promptOverride?: string;     // Use this instead of task.prompt
  awaitCompletion?: boolean;   // Wait for Claude to finish before returning
}
```

### Handoff Prompt Construction

When falling back, the orchestrator constructs a handoff prompt:

```
[This task was started by the Copilot SDK but hit a rate limit.
The original task prompt follows. Continue from where it left off.]

{original prompt}
```

The mode suffix prompt is re-appended so Claude gets the same behavioral instructions.

## 5. Where a New Provider Fits

### Option A: Primary (replaces Copilot)

Your provider runs first. If it fails/rate-limits, falls back to Copilot or Claude.

**Changes needed:**
1. Modify `shared-spawn.ts` to call your spawner instead of `spawnCopilotTask()`
2. Implement rotation within your provider (if applicable)
3. Wire `triggerClaudeFallback()` for exhaustion cases

### Option B: Middle (between Copilot and Claude)

Copilot runs first. If all accounts exhausted, try your provider. If that also fails, try Claude.

**Changes needed:**
1. Create a new `FallbackReason` entry
2. Modify `fallback-orchestrator.ts` to try your provider before Claude
3. Implement your runner function
4. Wire fallback-to-Claude from your provider on failure

### Option C: Additional Fallback (after Claude)

Your provider is the last resort.

**Changes needed:**
1. Modify `claude-code-runner.ts` to trigger your provider on Claude failure
2. Implement your runner function
3. Add `FallbackReason` entries

### Adding `FallbackReason` Entries

Currently, `FallbackRequest.reason` is a free-form string. Common values:

- `copilot_accounts_exhausted`
- `copilot_rate_limited`
- `copilot_non_rotatable_error`
- `copilot_unhandled_error`
- `copilot_startup_no_accounts`

Add entries like `your_provider_rate_limited`, `your_provider_error`, etc.

---

**Previous:** [06 — Provider Reference: Claude](./06-provider-reference-claude.md) · **Next:** [08 — Supporting Services](./08-supporting-services.md)
