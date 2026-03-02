## STDIO Transport Safety

This MCP server uses STDIO transport. stdout is the JSON-RPC protocol channel. Any non-protocol output to stdout corrupts framing and breaks the client connection immediately.

### Good
```typescript
console.error('[task-manager] Task completed', taskId);
console.error('[account-manager] Token rotated to index', nextIndex);
```

### Bad
```typescript
console.log('Task completed:', taskId);  // BREAKS MCP PROTOCOL
console.warn('Token rotated');           // BREAKS MCP PROTOCOL
console.info('Server started');          // BREAKS MCP PROTOCOL
```

## In-Place State Mutation

TaskManager stores tasks in a Map. appendOutput() and other consumers hold direct references to the task objects. Replacing the object in the Map breaks these references.

### Good
```typescript
// Mutates the existing object — all references stay valid
Object.assign(task, updates);

// Trim output in-place — same array reference
if (task.output.length > MAX_LINES) {
  task.output.splice(0, task.output.length - MAX_LINES);
}
```

### Bad
```typescript
// Creates a NEW object — appendOutput() now pushes to a stale copy
this.tasks.set(id, { ...task, ...updates });

// Creates a NEW array — reference holders still point to the old array
task.output = task.output.slice(-MAX_LINES);
```

## Async Re-Entrancy Prevention

Methods that manage shared state across await points must prevent concurrent execution. Without guards, a second call entering during the first's await can corrupt state.

### Good
```typescript
private isProcessingRateLimits = false;

private async processRateLimitedTasks(): Promise<void> {
  if (this.isProcessingRateLimits) return;  // Already running
  this.isProcessingRateLimits = true;
  try {
    const tasks = this.getTasksByStatus(TaskStatus.RATE_LIMITED);
    for (const task of tasks) {
      await this.retryTask(task);  // Safe: guard prevents re-entry
    }
  } finally {
    this.isProcessingRateLimits = false;  // Always clear
  }
}
```

### Bad
```typescript
// No guard — if called again during an await, runs concurrently
private async processRateLimitedTasks(): Promise<void> {
  const tasks = this.getTasksByStatus(TaskStatus.RATE_LIMITED);
  for (const task of tasks) {
    await this.retryTask(task);  // Another call enters here
  }
}
```

## Session ID vs Task ID After Rotation

When a token rotation occurs, the session is destroyed and a new one is created with a different session ID. The task ID stays the same, but the session ID diverges.

### Good
```typescript
// Use the sessionOwners map to resolve task ownership
const taskId = sdkClientManager.getTaskIdForSession(sessionId);
if (!taskId) {
  console.error('[sweeper] Orphaned session, no task owner:', sessionId);
  return;
}
const task = taskManager.getTask(taskId);
```

### Bad
```typescript
// WRONG: session ID != task ID after rotation
const task = taskManager.getTask(sessionId);  // Returns undefined after rotation!
```

## Path Traversal Prevention

Tool parameters and context file paths come from external clients. Validate containment within the workspace root before any filesystem operation.

### Good
```typescript
const resolvedCwd = await realpath(userProvidedPath);
const resolvedRoot = await realpath(workspaceRoot);
if (resolvedCwd.startsWith(resolvedRoot + '/') || resolvedCwd === resolvedRoot) {
  cwd = userProvidedPath;  // Safe: within workspace
} else {
  console.error('[sdk-spawner] CWD outside workspace, using root');
  cwd = workspaceRoot;    // Fallback to safe default
}
```

### Bad
```typescript
// No validation — user can escape workspace with ../../../etc/passwd
const cwd = userProvidedPath;
```

## Error Handling Tiers

Use the correct tier for each context. Mixing tiers causes either swallowed errors at API boundaries (silent failures) or thrown errors in cleanup paths (blocked shutdown).

### Tier 1: Swallow (Cleanup/Shutdown)
```typescript
// Cleanup must not throw — would block shutdown of other resources
async shutdown(): Promise<void> {
  try { await this.flushOutput(); } catch { /* swallow — best effort */ }
  try { await this.closeHandles(); } catch { /* swallow */ }
}
```

### Tier 2: Log and Continue (Event Handlers)
```typescript
// Non-critical failure — log and keep processing
session.on('error', (err) => {
  console.error('[session-adapter] Session error for task', taskId, err.message);
  // Don't throw — other sessions should keep working
});
```

### Tier 3: Propagate (API Boundaries)
```typescript
// Tool handlers must tell the caller what went wrong
if (!parsed.success) {
  return mcpValidationError(`Invalid parameters: ${parsed.error.message}`);
}
```

## Kill Escalation Protocol

Process termination follows a graduated escalation. Skipping steps can leave zombie processes or corrupt state.

### Good
```typescript
// 1. Graceful abort with timeout
try { await session.abort({ timeout: 5000 }); } catch { /* continue */ }
// 2. Signal abort controller
abortController.abort();
// 3. SIGTERM (polite shutdown request)
if (hasValidPid(pid)) process.kill(pid, 'SIGTERM');
// 4. Wait for graceful exit
await sleep(3000);
// 5. SIGKILL (force kill if still alive)
if (isStillAlive(pid)) process.kill(pid, 'SIGKILL');
```

### Bad
```typescript
// Skips graceful shutdown — process can't clean up
process.kill(pid, 'SIGKILL');
```

## Timer References Must Unref

Node.js timers keep the event loop alive. In an MCP server, forgetting `.unref()` means the process hangs after the client disconnects.

### Good
```typescript
const interval = setInterval(() => {
  checkStaleTasks();
}, 60_000).unref();  // Won't prevent process exit

const timeout = setTimeout(() => {
  cleanupExpiredSessions();
}, 30_000).unref();
```

### Bad
```typescript
// Process will hang during shutdown — timer keeps event loop alive
const interval = setInterval(() => {
  checkStaleTasks();
}, 60_000);
```

## Fire-and-Forget Session Send

The SDK session adapter subscribes to `session.idle` for completion detection. Using `sendAndWait()` creates a second completion handler that races with the adapter.

### Good
```typescript
// Adapter's session.idle handler is the single completion detector
session.send(finalPrompt);
```

### Bad
```typescript
// Double-completion race: sendAndWait's idle + adapter's idle
await session.sendAndWait(finalPrompt);
```
