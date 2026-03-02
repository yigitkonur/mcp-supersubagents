# Agent Guidelines

## Architecture

- This is an MCP server using **STDIO transport**. All user-facing state is in `src/services/`. Never bypass the service singletons — every service is instantiated once at module scope and exported as a named constant.
- Service dependency order: `taskManager` → `accountManager` → `sdkClientManager` → `sdkSessionAdapter`. Circular imports are broken with lazy `await import()` inside methods — check for cycles before adding new inter-service imports.
- Templates are `.mdx` files in `src/templates/`. The build script (`pnpm build`) copies them to `build/templates/` — `tsc` does not. If you add or rename template files, update the `cp` commands in the build script.

## Non-Negotiable Rules

- **NEVER use `console.log`** — STDIO transport reads stdout. A single `console.log` corrupts the MCP JSON-RPC framing and silently disconnects all clients. Use `console.error` for all logging.
- **NEVER use object spread to update tasks** — `this.tasks.set(id, { ...task })` creates a new object that breaks the live reference held by `appendOutput()`. Always use `Object.assign(task, updates)`.
- **NEVER use a string literal as a template replacement argument** — `.replace('{{user_prompt}}', userPrompt)` allows `$`-sequence injection. Use `.replace('{{user_prompt}}', () => userPrompt)`.

## Coding Standards

- All new services must export a singleton: `class Foo { ... } export const foo = new Foo();`
- Async reentrancy: check a boolean guard before the first `await`, set it immediately, clear it in `finally`. See `isProcessingRateLimits` in `task-manager.ts` as the canonical example.
- Serialized file writes: use `writeChain = writeChain.then(...)` for persistence and `enqueueWrite(key, fn)` for output files. Concurrent writes corrupt atomic temp-file-rename.
- Error handling tiers: (1) **swallow** in cleanup/shutdown paths, (2) **log and continue** for event handlers, (3) **propagate** at MCP API boundaries. Never throw from cleanup; never swallow in tool handlers.
- All timers (`setInterval`, `setTimeout`) must call `.unref()` to avoid blocking process exit on shutdown.

## Workflow

- Build: `pnpm build` (TypeScript errors are expected — `--noEmitOnError false` is intentional)
- Smoke test: `pnpm mcp:smoke` — the only automated verification
- Never commit `build/`, `node_modules/`, or `.super-agents/` output files

## Security

- PAT tokens must never appear in logs — use `getMaskedCurrentToken()` only. Review any code that iterates tokens or calls `exportCooldownState()`.
- The `specialization` parameter maps directly to a filesystem path via `join(__dirname, 'overlays', specialization + '.mdx')`. It MUST be validated to reject `/`, `\`, and `..` before use.
- Context file paths and `cwd` values must be validated with `realpath()` containment checks against the workspace root — `startsWith(resolvedRoot + '/')`. The `brief-validator.ts` enforces this; never bypass it.
- Error responses returned to MCP clients must never include stack traces, internal paths, or raw error objects — only sanitized messages via `mcpError()` or `mcpValidationError()`.

## Dependencies

- Use `zod` (v4) for all runtime input validation. Schemas live in `src/utils/sanitize.ts`.
- Use `@modelcontextprotocol/sdk` for MCP transport. Do not use raw STDIO JSON-RPC manually.
- Use `@github/copilot-sdk` for Copilot sessions with `useStdio: false` (TCP mode) to avoid macOS pipe race conditions.
- Use `unique-names-generator` for task ID generation — do not use `Math.random()` (too short, collision-prone).
