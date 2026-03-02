# MCP Super-SubAgents — Code Review Standards

## STDIO Transport Integrity

- **NEVER use `console.log()`** — it writes to stdout, which is the MCP JSON-RPC transport. A single stdout write silently corrupts all connected clients. This is the #1 production incident cause.
- All logging must use `console.error()` (stderr). No exceptions, even in debug/test branches.
- Verify that no imported dependency writes to stdout unexpectedly.

## Security

- PAT tokens must never appear in logs, error messages, or MCP responses — only `getMaskedCurrentToken()` output is safe
- Check for hardcoded secrets, API keys, or credentials in any new or changed code
- Validate and sanitize all external inputs at tool handler boundaries via Zod schemas
- File paths must be absolute — verify `isAbsolute()` checks are not bypassed
- Error responses to MCP clients must never include stack traces or internal paths
- The `specialization` parameter must not contain path traversal characters (`..`, `/`, `\`)

## Error Handling Tiers

All error handling must follow the established three-tier pattern:

1. **Swallow** — cleanup/shutdown paths that must not block: `try { ... } catch { /* swallow */ }`
2. **Log and continue** — non-critical event handlers: `console.error('[service] ...')`
3. **Propagate** — API boundaries (tool handlers, MCP requests): `throw` or `{ success: false }`

Never throw from cleanup paths. Never swallow at API boundaries.

## State Mutation Safety

- Task updates must use `Object.assign(task, updates)` — never `{ ...task, ...updates }` spread. The in-place mutation preserves live references held by `appendOutput()`.
- Output arrays must be trimmed with `splice(0, excess)`, not `slice(-limit)`.
- Always re-fetch task from Map after any `await` — state may have changed concurrently.

## Process & Resource Lifecycle

- All `setInterval`/`setTimeout` timers must call `.unref()` to avoid preventing process exit
- Close file handles and clean up resources in `finally` blocks
- Circular dependencies between services must use lazy `await import()` inside methods
