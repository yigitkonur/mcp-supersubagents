# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server that spawns and manages parallel AI sub-agents. The primary execution backend is the GitHub Copilot SDK (PTY-based, streaming events); when all Copilot accounts are rate-limited, the server automatically falls back to the Claude Agent SDK (`claude` CLI). The server exposes 4 MCP tools (`spawn_agent`, `send_message`, `cancel_task`, `answer_question`) over STDIO transport. Node.js >= 18.0.0.

## Build & Run

```bash
pnpm install     # install dependencies
pnpm build       # tsc --noEmitOnError false + copy .mdx templates to build/
pnpm dev         # tsx watch for hot-reload
pnpm start       # node build/index.js
pnpm clean       # remove build/
pnpm mcp:smoke   # MCP stdio protocol smoke test (scripts/mcp-stdio-smoke.mjs)
```

`--noEmitOnError false` means the build emits JS even with TypeScript errors. This is intentional — the SDK type surface is unstable and we use `(part as any)` casts in the Claude runner.

Transport is STDIO only. **All logging must use `console.error` (stderr). Any `console.log` corrupts the MCP JSON-RPC framing and silently breaks all connected clients.** This is the most common cause of production incidents.

No automated test suite. The only verification is `pnpm mcp:smoke`.

Binary names: `mcp-supersubagents`, `copilot-mcp-server`, `super-subagents`.

## Environment Variables

### PAT tokens (checked in priority order)

1. `GITHUB_PAT_TOKENS` — comma-separated list (recommended)
2. `GITHUB_PAT_TOKEN_1` through `GITHUB_PAT_TOKEN_100` — numbered
3. `GH_PAT_TOKEN` — comma-separated fallback
4. `GITHUB_TOKEN` / `GH_TOKEN` — single token

If no PAT is configured, tasks go directly to the Claude Agent SDK fallback.

### Feature flags

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_OPUS` | `false` | Show claude-opus-4.6 in tool schema enum (opus always usable via alias) |
| `DISABLE_CLAUDE_CODE_FALLBACK` | `false` | Disable fallback to Claude Agent SDK when all PATs exhausted |

### Timeouts (all in ms, defined in `src/config/timeouts.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TASK_TIMEOUT_MS` | 1,800,000 (30min) | Default task timeout |
| `MCP_TASK_TIMEOUT_MIN_MS` | 1,000 (1s) | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | 3,600,000 (1hr) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | 300,000 (5min) | No-output warning threshold |
| `MCP_TASK_TTL_MS` | 3,600,000 (1hr) | How long terminal tasks stay in memory |
| `BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS` | 15,000 (15s) | Max graceful shutdown wait |

### Copilot SDK

| Variable | Default | Purpose |
|---|---|---|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI binary |
| `DEBUG_SDK_EVENTS` | `false` | Log all SDK events to stderr |
| `MCP_ENABLED_TOOLS` | (unset = all) | Comma-separated tool names to keep in template TOOLKIT tables |

### Claude fallback

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_FALLBACK_MODEL` | `sonnet` | Override fallback model |
| `CLAUDE_FALLBACK_PERMISSION_MODE` | `bypassPermissions` | Claude permission mode |
| `MAX_CONCURRENT_CLAUDE_FALLBACKS` | `3` | Max simultaneous Claude sessions |
| `DEBUG_CLAUDE_FALLBACK` | `false` | Verbose stream-part logging |

---

## Architecture

### Service Singleton Pattern

Every service is a class instantiated once at module scope and exported as a named constant:

```typescript
class TaskManager { ... }
export const taskManager = new TaskManager();
```

Singletons: `taskManager`, `accountManager`, `sdkClientManager`, `sdkSessionAdapter`, `processRegistry`, `questionRegistry`, `progressRegistry`, `subscriptionRegistry`, `clientContext`.

Services import each other's singletons directly. Circular dependencies are broken with lazy `await import()` inside methods (e.g., `task-manager.ts` imports `claude-code-runner.ts` lazily).

### The Spawn Flow

```
MCP client calls spawn_agent
  → spawn-agent.ts: dispatch by role (coder/planner/tester/researcher)
  → shared-spawn.ts createSpawnHandler():
    1. Zod schema.parse(args)
    2. validateBrief() — prompt length, context file existence/size
    3. assemblePromptWithContext() — reads context files, injects into prompt
    4. applyTemplate() — matryoshka: base.mdx + overlay.mdx + user prompt
    5. spawnCopilotTask() — creates TaskState, resolves deps
  → sdk-spawner.ts:
    1. taskManager.createTask() — PENDING or WAITING if has depends_on
    2. setImmediate → runSDKSession() (returns task ID immediately)
    3. sdkClientManager.createSession() → session
    4. sdkSessionAdapter.bind(taskId, session) — subscribe to events
    5. session.send(prompt) — fire-and-forget (NOT sendAndWait)
  → sdk-session-adapter.ts:
    - Streams SessionEvent → taskManager.appendOutput/updateTask
    - On session.idle → COMPLETED
    - On session.error (429/5xx) → attempt rotation via callback
    - On all rotations exhausted → triggerClaudeFallback()
```

### Task State Machine

```
PENDING ──→ WAITING (if depends_on)
  │              │
  │              ├──→ PENDING (deps satisfied) ──→ RUNNING
  │              ├──→ FAILED (deps missing/circular/dead)
  │              ├──→ CANCELLED
  │              └──→ TIMED_OUT
  │
  └──→ RUNNING ──→ COMPLETED
                 ├──→ FAILED
                 ├──→ CANCELLED
                 ├──→ TIMED_OUT
                 └──→ RATE_LIMITED ──→ RUNNING (auto-retry)
                                   └──→ FAILED (max retries, backoff: 5m→10m→20m→40m→1h→2h)
```

Legal transitions are enforced by `VALID_TRANSITIONS` map in `task-manager.ts`. Illegal transitions are logged and silently rejected. Terminal statuses (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) cannot change further.

Internal 8-state → MCP 5-state mapping handled by `task-status-mapper.ts`.

### Provider Fallback Chain

```
Task created → check PAT tokens
  ├─ Tokens available → Copilot SDK Session (primary)
  │   ├─ 429/5xx → rotate PAT token (up to 10 attempts per session)
  │   │   ├─ Rotation success → new session, rebind metrics, send handoff prompt
  │   │   └─ All exhausted → Claude Agent SDK fallback
  │   └─ Quota <1% → proactive rotation before hard rate limit
  ├─ No tokens → Claude Agent SDK fallback (immediate)
  └─ DISABLE_CLAUDE_CODE_FALLBACK=true + all exhausted → FAILED
```

`task.fallbackAttempted` is a single-flight guard — `triggerClaudeFallback` is a no-op if already true.

### Token Rotation

```
account-manager.ts (round-robin):
  Token A → Token B → Token C → Token A → ...
  On failure: mark token with failedAt, 60s cooldown
  Auto-heal: stale failures >5min cleared
  All exhausted → trigger Claude fallback (if enabled)
```

Rotation can happen mid-session. The spawner destroys the old session, creates a new one, and `sdk-session-adapter.ts` rebinds via `rebindWithNewSession()` — preserving turn count, token totals, tool metrics, and output buffer.

### Template System (Matryoshka)

Templates are `.mdx` files loaded once and cached. `applyTemplate()` composes them:

1. Load base template (e.g., `super-coder.mdx`)
2. Load specialization overlay (e.g., `overlays/coder-typescript.mdx`)
3. Inject overlay before `## BEGIN` section
4. Filter TOOLKIT table rows if `MCP_ENABLED_TOOLS` is set
5. Replace `{{user_prompt}}` with the user's prompt

If you add/rename templates, update the `pnpm build` script — `tsc` only compiles `.ts`, the build script copies `.mdx` files separately.

### Persistence & Output

Two `.super-agents/` locations:

| Location | Contents |
|---|---|
| `~/.super-agents/{md5(cwd)}.json` | Task state persistence (atomic: temp → fsync → rename) |
| `{cwd}/.super-agents/{task-id}.output` | Verbose execution logs (streamable with `tail -f`) |

Persistence uses a dirty-check hash to skip redundant writes. Write serialization via Promise chains (`writeChains` Map) prevents concurrent corruption.

On server restart: `RUNNING`/`PENDING`/`WAITING` → `FAILED`; `RATE_LIMITED` preserved for auto-retry.

### Process Kill Escalation

```
processRegistry.killTask(taskId):
  1. session.abort() with 5s timeout
  2. abortController.abort() (Claude fallback)
  3. SIGTERM to PID/PGID
  4. Wait 3 seconds
  5. SIGKILL if still alive
```

### Inter-Service Communication

- **Direct method calls** — the common case between singletons
- **Callbacks** — task-manager registers `onExecute`, `onRetry`, `onOutput`, `onStatusChange`; session adapter registers `onRotationRequest` with the spawner
- **No event bus** — communication is explicit, no pub/sub between services

---

## Critical Code Patterns

### State Mutation: In-Place with Object.assign

`taskManager.updateTask()` uses `Object.assign(task, updates)` — **not** spread/replace. This preserves the object reference in the Map so that `appendOutput()` (which holds a direct reference) never pushes to a stale copy.

```typescript
// CORRECT — same reference in Map
Object.assign(task, { status: TaskStatus.COMPLETED });

// WRONG — breaks appendOutput() references, causes silent data loss
this.tasks.set(id, { ...task, status: TaskStatus.COMPLETED });
```

Output arrays are trimmed with `splice(0, excess)`, not `slice(-limit)`, to avoid copying and breaking references.

### Async Race Prevention

1. **Boolean guards** — `isProcessingRateLimits`, `isClearing`, `isShuttingDown`, `rotationInProgress`, `isUnbound`, `timingOutTasks` Set. Check before first await, set immediately, clear in finally.

2. **Write chains** — `task-persistence.ts` serializes disk writes with `writeChain = writeChain.then(...)`. `output-file.ts` serializes per-task writes with `enqueueWrite(key, fn)`.

3. **queueMicrotask** — `onExecute()` triggers `processWaitingTasks()` via microtask to batch dependency checks.

4. **Idempotent cleanup** — `binding.isUnbound` in `sdk-session-adapter.ts` ensures `unbind()` is safe to call multiple times.

5. **Terminal state check after await** — Always re-fetch task from Map after any await to detect cancellation/completion that happened concurrently.

### Error Handling Tiers

1. **Swallow** — cleanup/shutdown paths that must not block: `try { ... } catch { /* swallow */ }`
2. **Log and continue** — `console.error('[service-name] ...')` with structured prefix. Non-critical paths.
3. **Propagate** — `throw` or return `{ success: false }` at API boundaries (tool handlers, MCP requests).

### SDK Type Casts

`(part as any)` casts in `claude-code-runner.ts` are intentional — the AI SDK provider type union doesn't expose stream part properties (`delta`, `toolName`, `toolCallId`, `finishReason`) consistently across versions. Don't remove without verifying against the actual SDK version.

---

## Brief Validation Rules

| Role | Min prompt | Context files | .md required | Model override |
|---|---|---|---|---|
| coder | 1000 chars | Yes (min 1) | Yes | Allowed |
| planner | 300 chars | No | No | **Always Opus** (forced) |
| tester | 300 chars | Yes (min 1) | No | Allowed |
| researcher | 200 chars | No | No | Allowed |

File limits: max 20 files, 200KB each, 500KB total. Files must be absolute paths.

---

## Limits

| Limit | Value | Behavior |
|---|---|---|
| Max in-memory tasks | 100 | Evicts oldest terminal; if all 100 active, spawn fails |
| Max output lines per task | 2,000 | Oldest trimmed via splice |
| Max context files per spawn | 20 | Zod rejects |
| Max file size per context file | 200KB | Brief validator rejects |
| Max total context size | 500KB | Brief validator rejects |
| Max PAT tokens | 100 | Extras silently dropped |
| Max labels per task | 10 (50 chars each) | Zod rejects |
| Question timeout | 30 minutes | Task fails |
| Max rotation attempts per session | 10 | Falls through to fallback/RATE_LIMITED |
| Zombie session threshold | 10 minutes | No output → session destroyed, task FAILED |
| Stale file handle age | 5 minutes | Output file handles closed |
| PTY FD recycle threshold | 80 ptmx FDs | Triggers CopilotClient recycling |
| Max concurrent Claude fallbacks | 3 | Queue-based throttling |

---

## Gotchas

- **stdout must be clean** — All logging is `console.error`. A single `console.log` corrupts MCP STDIO framing. Even in debugging — use `console.error` or write to the output file.
- **super-planner always uses Opus** — `resolveModel()` in `src/models.ts` ignores the model parameter for planner; always returns `claude-opus-4.6`.
- **Session ID != Task ID after rotation** — After a token rotation rebind, the session gets a new ID (`{taskId}-r{N}`). Use `sdkClientManager.sessionOwners` map to resolve. Never assume they're equal.
- **TCP mode, not stdio** — `sdk-client-manager.ts` creates CopilotClient with `useStdio: false` to avoid macOS stdio pipe race conditions.
- **`session.send()` not `sendAndWait()`** — Using fire-and-forget avoids a double-completion race where both `sendAndWait`'s idle handler and the adapter's `session.idle` handler compete.
- **`setImmediate` for task execution** — Returns task ID to MCP client immediately, prevents tool call timeouts on slow session init.
- **In-place mutation is load-bearing** — `updateTask()` uses `Object.assign`, not spread. Creating a new object breaks `appendOutput()` references. See "State Mutation" above.
- **Two `.super-agents/` locations** — Persistence: `~/.super-agents/{md5(cwd)}.json`. Output files: `{cwd}/.super-agents/{task-id}.output`.
- **Build copies .mdx files** — `tsc` only compiles `.ts`. If you add/rename templates, update the copy commands in the build script.
- **Version from package.json** — `src/index.ts` reads version at runtime via `createRequire`. No manual sync needed.
- **Unhandled errors are non-fatal** — The server catches unhandled rejections and uncaught exceptions to keep MCP transport alive.
- **Timers must `.unref()`** — Any `setInterval`/`setTimeout` must call `.unref()` to not prevent process exit during shutdown.
- **Circular deps use lazy imports** — New inter-service imports must check for cycles and use `await import()` inside methods if needed.
- **PAT tokens must never appear in logs** — Only the masked form (`getMaskedCurrentToken()`) is safe. Review any code touching `exportCooldownState()` or token iteration.
- **Specialization parameter lacks path validation** — It is used in `join(__dirname, 'overlays', ...)` for template loading. Any modification must prevent path traversal (`..`, `/`, `\`).

---

## MCP Resources

| URI | Content |
|---|---|
| `system:///status` | Account stats, SDK health, task counts |
| `task:///all` | All tasks with status, progress, pending questions |
| `task:///{id}` | Full task detail, output tail, metrics |
| `task:///{id}/session` | Execution log with tool calls and turn data |

Resource notifications are debounced to max 1/sec per task. Output filtered for MCP consumers removes noise: `[reasoning]`, `[usage]`, `[quota]`, `[hooks]` prefixes.

---

## Additional Documentation

- `docs/ARCHITECTURE.md` — detailed system architecture with state diagrams and protocol flow
- `README.md` — user guide, quick start, tool reference, workflows, troubleshooting
- `REVIEW.md` — code review guidelines, security checklist, conventions, anti-patterns
- `AUDIT.md` — security audit findings and remediation
