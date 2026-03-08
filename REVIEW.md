# Review Guidelines

## Critical Areas

- **STDIO transport integrity** — Any change that adds logging or output must be verified to use `console.error` (stderr), never `console.log` (stdout). A single stdout write corrupts the MCP JSON-RPC framing and silently breaks all connected clients. This is the most common source of production incidents in this codebase.
- **Task state machine** (`src/services/task-manager.ts`) — Status transitions are enforced by the `VALID_TRANSITIONS` map. Any PR modifying `updateTask()`, `appendOutput()`, or status-changing logic must preserve the `Object.assign()` in-place mutation pattern. Replacing it with object spread (`{ ...task, ...updates }`) breaks live references held by `appendOutput()` and causes silent data loss.
- **Token and credential handling** (`src/services/account-manager.ts`) — PAT tokens must never appear in log output, error messages, or MCP responses. Only the masked form (`getMaskedCurrentToken()`) is safe to log. Review any change touching `exportCooldownState()` or token iteration to ensure raw tokens are not leaked.
- **Process lifecycle** (`src/services/process-registry.ts`) — Kill escalation follows a strict sequence: `session.abort()` → `abortController.abort()` → `SIGTERM` → wait 3s → `SIGKILL`. Any change to this sequence must preserve the escalation order and handle entries without PIDs (Claude fallback sessions have only an AbortController).
- **Session binding** (`src/services/sdk-session-adapter.ts`) — After token rotation, the session ID changes but the task ID does not. Any code assuming `sessionId === taskId` will silently break after rotation. Always resolve via `sdkClientManager.sessionOwners` map.
- **Claude fallback permission mode** (`src/services/claude-code-runner.ts`) — `DEFAULT_PERMISSION_MODE` is `'bypassPermissions'` for parity with Copilot's `approveAll` handler. Override via `CLAUDE_FALLBACK_PERMISSION_MODE=plan` if a restricted sandbox is needed. Any PR removing the env var override MUST include explicit justification for the security trade-off.

## Security

- Tool handlers in `src/tools/` are the primary input boundary. All parameters must be validated through Zod schemas in `src/utils/sanitize.ts` before use. Never access raw arguments without schema parsing.
- File path parameters (`context_files[].path`, `cwd`) must be absolute paths. The `brief-validator.ts` enforces `isAbsolute()` — any bypass or weakening of this check enables directory traversal.
- The `specialization` parameter in spawn schemas currently lacks pattern validation. Any PR adding or modifying specialization handling must ensure the value cannot contain path traversal characters (`..`, `/`, `\`). It is used in `join(__dirname, 'overlays', ...)` for template loading.
- The `cwd` option in spawn/send-message is validated against the workspace root in `sdk-spawner.ts` using `realpath()` containment checks. Changes to CWD validation must preserve symlink resolution and the `startsWith(resolvedRoot + '/')` boundary check.
- Error responses returned to MCP clients (via `mcpError()`, `mcpValidationError()`) must never include stack traces, internal file paths, or raw error objects. Only sanitized messages are safe.
- The `claude-code-runner.ts` filters dangerous bash commands (`rm -rf /`, `mkfs`, `dd`, `shutdown`, `reboot`, `chown`). Changes to the tool policy filter must not weaken this list.
- Control characters are stripped from user answers in `question-registry.ts` (`\x00-\x1f`, `\x80-\x9f`). Any new user input path must apply equivalent sanitization.
- Template replacement in `src/templates/index.ts` MUST use a function replacer: `.replace('{{user_prompt}}', () => userPrompt)`. Using a string literal as the second argument (`.replace(pattern, userPrompt)`) causes JavaScript to interpret `$` sequences — `$$`, `$&`, `$\``, `$'`, `$n` — as special substitution patterns, enabling prompt injection via user-controlled content containing `$` characters (VE-003, High). Never pass untrusted content as a string replacer argument.

## Conventions

- All logging must use `console.error()` — this is not optional. The MCP STDIO transport reads stdout. Even a debug `console.log` in a rarely-hit branch will eventually corrupt the protocol.
- Task state updates must use `Object.assign(task, updates)` — never `this.tasks.set(id, { ...task, ...updates })`. The in-place mutation pattern is load-bearing: `appendOutput()` holds a direct reference to the task object in the Map.
- Async race prevention uses boolean guards (`isProcessingRateLimits`, `isClearing`, `isShuttingDown`) that must be checked before the first `await`, set immediately after, and cleared in a `finally` block. PRs adding new async entry points must follow this pattern.
- Write serialization: `task-persistence.ts` uses `writeChain = writeChain.then(...)` and `output-file.ts` uses `enqueueWrite()`. Any new file I/O path must serialize writes — concurrent writes corrupt the atomic temp-file-rename pattern.
- Error handling follows three tiers: (1) **Swallow** in cleanup/shutdown paths that must not block, (2) **Log and continue** for non-critical event handlers, (3) **Propagate** at API boundaries (tool handlers, MCP request handlers). New code must use the appropriate tier — never throw from cleanup paths, never swallow at API boundaries.
- Tool responses must use `mcpText()` or `mcpError()` from `src/utils/format.ts`. Raw `{ content: [...] }` objects bypass error formatting and table escaping.
- Timers created with `setInterval` or `setTimeout` must call `.unref()` so they do not prevent process exit during shutdown.
- Circular dependencies between services are broken with lazy `await import()` inside methods, not top-level imports. New inter-service imports must check for cycles.

## Performance

- Output arrays are trimmed in-place with `splice(0, excess)` — never `slice(-limit)`. The `slice` alternative allocates a new array, breaking live references and increasing GC pressure on high-output tasks.
- File descriptor management: `output-file.ts` closes stale handles after 5 minutes and the `sdk-client-manager.ts` recycles `CopilotClient` instances when PTY FD count exceeds 80. Changes to file or session handling must not leak handles.
- The `processWaitingTasks()` method is triggered via `queueMicrotask()` to batch dependency checks when multiple tasks are created synchronously. Replacing this with direct invocation causes O(n^2) dependency scanning.
- Task persistence uses a dirty-check hash (length + 3 sample charCodes) to skip redundant disk writes. Changes to the serialization format must update the hash function or remove it — a stale hash causes missed writes.
- `MAX_TASKS` is 100 in-memory. When all 100 are active (non-terminal), spawns fail. Eviction targets oldest terminal tasks first. Changes to cleanup logic must preserve this eviction order.

## Patterns

### Async Guard (Reentrancy Prevention)

**Good:**
```typescript
private isProcessing = false;

async processItems(): Promise<void> {
  if (this.isProcessing) return;
  this.isProcessing = true;
  try {
    await this.doAsyncWork();
  } finally {
    this.isProcessing = false;
  }
}
```

**Bad:**
```typescript
async processItems(): Promise<void> {
  // No guard — concurrent calls cause duplicate work and race conditions
  await this.doAsyncWork();
}
```

### Task State Update

**Good:**
```typescript
Object.assign(task, { status: TaskStatus.COMPLETED, completedAt: Date.now() });
// Same reference in Map — appendOutput() still works
```

**Bad:**
```typescript
this.tasks.set(id, { ...task, status: TaskStatus.COMPLETED });
// New object — appendOutput() pushes to stale reference, output silently lost
```

### Logging in MCP Server

**Good:**
```typescript
console.error('[service-name] Task failed:', taskId, error.message);
```

**Bad:**
```typescript
console.log('Task failed:', taskId, error);
// stdout write → MCP JSON-RPC frame corrupted → client disconnects
```

### Terminal Status Guard

**Good:**
```typescript
const latestTask = this.getTask(taskId);
if (!latestTask || isTerminalStatus(latestTask.status)) return;
// Safe to update — task still active
```

**Bad:**
```typescript
// Using stale task reference from before an await — task may have been
// cancelled/completed while we were waiting
Object.assign(task, { status: TaskStatus.RUNNING });
```

## Ignore

- `build/` directory contains compiled output — review source in `src/` instead.
- `*.d.ts` declaration files are auto-generated by `tsc`.
- `pnpm-lock.yaml` changes from dependency updates do not need line-by-line review.
- `.mdx` template files in `src/templates/overlays/` are static prompt text — review only for prompt injection concerns, not code correctness.
- `node_modules/` should never be committed.
- `.super-agents/` contains runtime output files — not source code.

## Testing

- There is no automated test suite. The only verification is `pnpm mcp:smoke` (end-to-end MCP STDIO smoke test in `scripts/mcp-stdio-smoke.mjs`). PRs adding new tool handlers or modifying state machine transitions should include smoke test coverage or explain why existing coverage suffices.
- Schema consistency: the Zod schemas in `src/utils/sanitize.ts` must match the `inputSchema` objects registered in `src/tools/*.ts`. Divergence causes silent validation bypasses or false rejections.
- State machine transitions: any PR adding a new `TaskStatus` value must update `VALID_TRANSITIONS`, `isTerminalStatus()`, and `task-status-mapper.ts`. Missing updates cause illegal transitions to be silently dropped.
