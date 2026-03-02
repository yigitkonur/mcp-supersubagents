---
applyTo: "src/**/*.ts"
---

# MCP Transport & Protocol Guidelines

## STDIO Safety — Critical

- **NEVER use `console.log()`** — stdout is the JSON-RPC transport. Use `console.error()` for all diagnostics.
- Verify new dependencies don't write to stdout. Even a single stray `console.log` in a rarely-hit branch will eventually corrupt the protocol.
- The `appendOutputFileOnly()` method writes verbose debug output to disk — use it for debug data that shouldn't go through MCP.

```typescript
// WRONG — breaks all MCP clients
console.log('[debug] task started', taskId);

// CORRECT — stderr for diagnostics
console.error('[sdk-spawner] task started', taskId);
```

## MCP Response Format

- Tool responses must use `mcpText()` or `mcpError()` from `src/utils/format.ts` — never raw `{ content: [...] }` objects
- Validation failures must use `mcpValidationError()` with `isError: true`
- Error responses must never include stack traces, internal file paths, or raw error objects

## Resource Notifications

- Resource notifications (`sendResourceUpdated`) are debounced to max 1/sec per task
- All `sendResourceUpdated()` and `notification()` calls must have `.catch(() => {})` — fire-and-forget pattern prevents unhandled rejections from crashing the server
- Output filtered for MCP consumers strips noise prefixes: `[reasoning]`, `[usage]`, `[quota]`, `[hooks]`, `[session]`

## Connection Lifecycle

- Handle broken pipe errors gracefully — check `BROKEN_PIPE_ERROR_CODES` Set
- Implement graceful shutdown: abort sessions → clean up resources → exit
- The `BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS` (15s) limits graceful shutdown wait time
