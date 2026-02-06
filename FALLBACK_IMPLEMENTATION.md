# Claude Agent SDK Fallback Implementation

This document describes the implementation of the Claude Agent SDK fallback when Copilot accounts are exhausted.

## Overview

When all GitHub Copilot PAT accounts are exhausted (rate-limited or in cooldown), the system automatically falls back to Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to continue task execution.

## Key Components

### 1. New Services

#### `/src/services/exhaustion-fallback.ts`
- **Purpose**: Policy checker for when to activate fallback
- **Key function**: `shouldFallbackToClaudeCode(rotationResult)` - returns true ONLY when `allExhausted=true`
- **Environment variable**: `DISABLE_CLAUDE_CODE_FALLBACK=true` to disable fallback (defaults to enabled)

#### `/src/services/session-snapshot.ts`
- **Purpose**: Extract bounded context from Copilot session for handoff
- **Key function**: `buildHandoffPrompt(task, maxTurns)` - builds handoff prompt with last N turns
- **Bounds**: Max 5 turns, 2K chars per message, 20K total snapshot size

#### `/src/services/claude-code-runner.ts`
- **Purpose**: Execute tasks using Claude Agent SDK
- **Key function**: `runClaudeCodeSession(taskId, prompt, cwd, timeout, resumeSessionId?)`
- **Features**:
  - Streams output to task output file
  - Tracks tool metrics and token usage
  - Handles session resumption via `sessionId`
  - Sets `provider: 'claude-cli'` and fallback metadata

### 2. Integration Points

#### `/src/services/sdk-spawner.ts`
Two integration points:

**A. Pre-task check (line ~104)**
- Before starting a new task, check if any Copilot accounts are available via `accountManager.getCurrentToken()`
- If no token available, immediately use Claude Agent SDK
- No Copilot session is created

**B. Mid-task exhaustion (line ~399)**
- In `handleRateLimit()` function when `rotationResult.allExhausted=true`
- Unbind Copilot session
- Build handoff prompt from session snapshot
- Calculate remaining timeout
- Continue with Claude Agent SDK

#### `/src/services/sdk-session-adapter.ts` (line ~530)
- In `attemptRotationAndResume()` when mid-session rotation fails with `allExhausted`
- Unbind Copilot session
- Build handoff prompt from session snapshot
- Calculate remaining timeout
- Delegate to Claude Agent SDK (async, doesn't block)

### 3. Type Extensions

#### `/src/types.ts`
Added to `SessionMetrics` interface:
```typescript
provider?: Provider; // 'copilot' | 'claude-cli'
fallbackActivated?: boolean;
fallbackReason?: string; // 'copilot-accounts-exhausted'
```

Existing fields used:
- `TaskState.provider: Provider` - tracks which SDK is active
- `TaskState.sessionId: string` - stores session ID for both Copilot and Claude
- `TaskState.sessionMetrics: SessionMetrics` - includes fallback metadata

## Behavior

### Sticky Provider Rule
Once a task switches to Claude Agent SDK (`provider: 'claude-cli'`), it NEVER attempts to switch back to Copilot for that task. This prevents ping-ponging between providers.

### When Fallback Activates
Fallback ONLY activates when:
- `accountManager.rotateToNext()` returns `{ allExhausted: true }`
- This means ALL Copilot accounts are in cooldown (exhausted)

Fallback does NOT activate for:
- Auth errors (401/403)
- Timeouts
- Single-account failures
- Network errors

### Session Handoff
When switching from Copilot to Claude Agent SDK:
1. Extract last 5 turns from Copilot output file
2. Truncate messages to 2K chars each, 20K total
3. Build prompt: "You are continuing a task... Original prompt: ... Recent context: ..."
4. Calculate remaining timeout from original task timeout
5. Start Claude Agent SDK session with handoff prompt

### Logging
Clear logging indicates fallback activation:
```
[sdk-spawner] All Copilot accounts exhausted for task <id>, falling back to Claude Agent SDK
[system] All Copilot accounts exhausted. Switching to Claude Agent SDK...
[claude-code-runner] Starting Claude Agent SDK session for task <id>
```

### Metrics
Tasks that use fallback have:
```typescript
task.provider = 'claude-cli'
task.sessionMetrics.provider = 'claude-cli'
task.sessionMetrics.fallbackActivated = true
task.sessionMetrics.fallbackReason = 'copilot-accounts-exhausted'
```

## Dependencies

- `@anthropic-ai/claude-agent-sdk@^0.2.34` - Claude Agent SDK
- `zod@^4.0.0` - Upgraded from v3 for SDK compatibility

## Persistence

The following fields are automatically persisted to `~/.super-agents/{hash}.json`:
- `provider`
- `sessionId` (works for both Copilot and Claude sessions)
- `sessionMetrics` (includes fallback metadata)

The `session` field (runtime object) is excluded from persistence.

## Testing

### Manual Verification

1. **Setup**: Set invalid or exhausted PAT token
   ```bash
   export GITHUB_PAT_TOKENS="ghp_invalidtoken123"
   npm run build && npm start
   ```

2. **Trigger fallback**: Spawn a task via MCP `spawn_task` tool

3. **Verify**:
   - Console logs show fallback activation
   - Task output shows Claude Agent SDK continuation message
   - Task completes successfully (status: COMPLETED)
   - Read task resource: `provider: 'claude-cli'`, `sessionId` populated

4. **Test rollback**: Disable fallback
   ```bash
   export DISABLE_CLAUDE_CODE_FALLBACK=true
   npm start
   # Task should FAIL with "All accounts exhausted"
   ```

### Edge Cases

1. **Claude Agent SDK not installed**: Task fails with clear error message
2. **Claude CLI not authenticated**: Task fails with "Run: claude login" message
3. **Claude Agent SDK fails**: Task transitions to FAILED with proper `failureContext`
4. **Timeout during Claude execution**: Task transitions to TIMED_OUT
5. **No Copilot accounts on startup**: Immediately uses Claude Agent SDK

## Rollback Switch

Set `DISABLE_CLAUDE_CODE_FALLBACK=true` to disable fallback. Tasks will fail with "All accounts exhausted" when Copilot accounts are exhausted (original behavior).

## Architecture Decisions

### Why this seam?
The integration point in `sdk-spawner.ts:handleRateLimit()` was chosen because:
1. Single point of control for all exhaustion paths
2. Clear `allExhausted` signal from account manager
3. Full task context available for snapshot building
4. Minimal disruption to existing code
5. Symmetric with existing retry patterns

### Why not other seams?
- `account-manager.ts`: Too low-level, no task context
- `sdk-client-manager.ts`: No task state, can't build handoff prompt
- Multiple seams: Would create fragmented logic

### Provider tracking
Using existing `provider` field rather than new fields because:
1. Already exists in types
2. Clearly indicates which SDK is active
3. Persists automatically
4. No migration needed

## Future Improvements

1. **Smarter handoff**: Parse tool executions and file changes for better context
2. **Resume support**: Allow resuming Claude sessions across restarts
3. **Bidirectional switch**: Allow switching back to Copilot when accounts recover (requires careful design to avoid loops)
4. **Cost tracking**: Track usage by provider for billing/analytics
5. **Provider preference**: Allow user to prefer Claude Agent SDK over Copilot
