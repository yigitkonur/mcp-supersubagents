# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server that spawns and manages parallel AI sub-agents. The primary execution backend is the GitHub Copilot SDK; when all Copilot accounts are rate-limited, the server automatically falls back to the Claude Agent SDK (`claude` CLI). The server exposes 4 MCP tools (`spawn_agent`, `send_message`, `cancel_task`, `answer_question`) over STDIO transport. Node.js >= 18.0.0.

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

Transport is STDIO only. All logging goes to `console.error` (stderr). Any stdout output corrupts the MCP protocol.

Binary names: `mcp-supersubagents`, `copilot-mcp-server`, `super-subagents`.

No automated test suite. Use `pnpm mcp:smoke` for end-to-end verification.

## Environment Variables

### PAT tokens (checked in priority order)

1. `GITHUB_PAT_TOKENS` — comma-separated list (recommended)
2. `GITHUB_PAT_TOKEN_1`, `GITHUB_PAT_TOKEN_2`, ... — numbered
3. `GH_PAT_TOKEN` — comma-separated fallback
4. `GITHUB_TOKEN` / `GH_TOKEN` — single token

If no PAT is configured, tasks go directly to the Claude Agent SDK fallback.

### Feature flags

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_OPUS` | `false` | Show claude-opus-4.6 in tool schema enum (opus is always usable via alias) |
| `DISABLE_CLAUDE_CODE_FALLBACK` | `false` | Disable fallback to Claude Agent SDK when all PATs exhausted |

### Timeouts (all in ms, defined in `src/config/timeouts.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TASK_TIMEOUT_MS` | 1,800,000 (30min) | Default task timeout |
| `MCP_TASK_TIMEOUT_MIN_MS` | 1,000 (1s) | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | 3,600,000 (1hr) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | 300,000 (5min) | No-output warning threshold |
| `MCP_TASK_TTL_MS` | 3,600,000 (1hr) | How long terminal tasks stay in memory |
| `BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS` | 15,000 (15s) | Max graceful shutdown wait after broken pipe |

### Copilot SDK

| Variable | Default | Purpose |
|---|---|---|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI binary |
| `DEBUG_SDK_EVENTS` | `false` | Log all SDK events to stderr |
| `MCP_ENABLED_TOOLS` | (unset = all) | Comma-separated tool names to keep in template TOOLKIT tables |

---

## Source Layout

```
src/
├── index.ts                    # MCP server: tool registration, resource handlers, shutdown
├── types.ts                    # TaskState, TaskStatus enum, shared interfaces
├── models.ts                   # Model IDs, ENABLE_OPUS visibility, resolveModel()
├── copilot-sdk.d.ts            # Module augmentation for missing @github/copilot-sdk types
├── config/
│   └── timeouts.ts             # readIntEnv() + exported timeout constants
├── services/
│   ├── task-manager.ts         # Central state machine, dependency resolution, health checks
│   ├── account-manager.ts      # Round-robin PAT rotation with 60s cooldown
│   ├── sdk-spawner.ts          # Creates Copilot sessions, handles rate-limit retry
│   ├── sdk-session-adapter.ts  # Maps SDK SessionEvent → TaskState updates
│   ├── sdk-client-manager.ts   # CopilotClient pool per workspace (TCP mode)
│   ├── claude-code-runner.ts   # Claude Agent SDK executor (fallback path)
│   ├── fallback-orchestrator.ts# Triggers Claude fallback with session snapshot
│   ├── exhaustion-fallback.ts  # Policy: shouldFallbackToClaudeCode()
│   ├── session-snapshot.ts     # Extracts bounded context for fallback handoff
│   ├── retry-queue.ts          # Exponential backoff schedule + shouldRetryNow()
│   ├── task-persistence.ts     # Atomic writes to ~/.super-agents/{md5(cwd)}.json
│   ├── output-file.ts          # Streams output to {cwd}/.super-agents/{task-id}.output
│   ├── process-registry.ts     # Tracks child PIDs + AbortControllers for kill escalation
│   ├── question-registry.ts    # Pending ask_user questions with 30min timeout
│   ├── progress-registry.ts    # Real-time MCP progress notifications
│   ├── subscription-registry.ts# Resource URI subscription tracking
│   ├── task-status-mapper.ts   # Internal TaskStatus → MCP Task status mapping
│   ├── client-context.ts       # Workspace root discovery & default cwd
│   └── session-hooks.ts        # SDK event hooks (message, error, shutdown)
├── tools/
│   ├── spawn-agent.ts          # Tool definition + role dispatch (coder/planner/tester/researcher)
│   ├── shared-spawn.ts         # Shared spawn factory: validate → assemble → template → spawn
│   ├── send-message.ts         # Resume a terminal task's session with follow-up
│   ├── cancel-task.ts          # Cancel one, many, or all tasks
│   └── answer-question.ts      # Respond to pending ask_user questions
├── templates/
│   ├── index.ts                # Template loading, matryoshka composition, tool filtering
│   ├── super-coder.mdx         # Coder system prompt
│   ├── super-planner.mdx       # Planner system prompt (always uses Opus)
│   ├── super-researcher.mdx    # Researcher system prompt
│   ├── super-tester.mdx        # Tester system prompt
│   └── overlays/               # Specialization overlays injected before ## BEGIN
│       ├── coder-{lang}.mdx    # typescript, python, rust, go, java, ruby, swift, etc.
│       ├── planner-{type}.mdx  # feature, bugfix, migration, refactor, architecture
│       ├── researcher-{type}.mdx # security, library, performance
│       └── tester-{type}.mdx   # playwright, rest, graphql, suite
└── utils/
    ├── sanitize.ts             # Zod v4 schemas for all tool inputs
    ├── brief-validator.ts      # Validates prompt length, context files, file size limits
    ├── task-id-generator.ts    # Human-readable IDs: {adjective}-{animal}-{number}
    └── format.ts               # MCP response helpers: mcpText(), mcpValidationError()
```

---

## Architecture & Code Patterns

### Singletons

Every service is a class instantiated once at module scope and exported as a named constant:

```typescript
class TaskManager { ... }
export const taskManager = new TaskManager();
```

This applies to: `taskManager`, `accountManager`, `sdkClientManager`, `sdkSessionAdapter`, `processRegistry`, `questionRegistry`, `progressRegistry`, `subscriptionRegistry`, `clientContext`.

Services import each other's singletons directly. Circular dependencies are broken with lazy `await import()` inside methods (e.g., `task-manager.ts` imports `claude-code-runner.ts` lazily to avoid a circular with `sdk-spawner.ts`).

### State Mutation: In-Place with Object.assign

`taskManager.updateTask()` uses `Object.assign(task, updates)` — **not** spread/replace. This preserves the object reference in the Map so that `appendOutput()` (which holds a direct reference to the task object) never pushes to a stale copy.

```typescript
// DO NOT replace the object — appendOutput holds a live reference
Object.assign(task, updates);
// No need to re-set in Map — same reference
```

`appendOutput()` mutates `task.output` (push) and `task.lastOutputAt` directly. Output arrays are trimmed in-place with `splice(0, excess)` rather than `slice(-limit)` to avoid copying.

### Async Race Prevention

The codebase uses several patterns to prevent re-entrant execution:

1. **Boolean guards** — `isProcessingRateLimits`, `isClearing`, `isShuttingDown`, `rotationInProgress`, `isUnbound`, `timingOutTasks` Set. Always check before entering an async section, set before the first await, clear in finally.

2. **Write chains** — `task-persistence.ts` serializes disk writes with `writeChain = writeChain.then(...)`. `output-file.ts` serializes per-task writes with `enqueueWrite(key, fn)`.

3. **queueMicrotask** — `onExecute()` triggers `processWaitingTasks()` via microtask to batch dependency checks when multiple tasks are created synchronously.

4. **Idempotent cleanup** — `binding.isUnbound` in `sdk-session-adapter.ts` ensures `unbind()` is safe to call multiple times. The second call is a no-op.

### Error Handling: Three Tiers

1. **Swallow** — cleanup paths that must not block forward progress: `try { ... } catch { /* swallow */ }`. Used in shutdown, abort, and best-effort cleanup.

2. **Log and continue** — `console.error('[service-name] ...')` with structured prefix. The error is recorded but execution continues. Used in event handlers, health checks, and non-critical paths.

3. **Propagate** — `throw new Error(...)` or return `{ success: false, error: '...' }`. Used at API boundaries (tool handlers, MCP request handlers) where the caller needs to know.

All logging goes to stderr (`console.error`). Never use `console.log` — it would corrupt STDIO transport.

### Inter-Service Communication

- **Direct method calls** — the common case. `sdkSpawner` calls `taskManager.createTask()`, `sdkClientManager.createSession()`, etc.
- **Callbacks** — for delegation patterns where the callee needs to invoke logic owned by the caller. Task-manager registers `onExecute`, `onRetry`, `onOutput`, `onStatusChange` callbacks. Session adapter registers `onRotationRequest` with the spawner.
- **No event bus** — there is no pub/sub or event emitter pattern between services. Communication is explicit.

### The Spawn Flow

```
MCP client calls spawn_agent
  → spawn-agent.ts: dispatch by role (coder/planner/tester/researcher)
  → shared-spawn.ts createSpawnHandler():
    1. Zod schema.parse(args) — validates inputs
    2. validateBrief() — checks prompt length, context file existence/size
    3. assemblePromptWithContext() — reads context files, injects into prompt
    4. applyTemplate() — matryoshka: base.mdx + overlay.mdx + user prompt
    5. spawnCopilotTask() — creates TaskState, resolves deps, starts execution
  → sdk-spawner.ts:
    1. taskManager.createTask() — PENDING or WAITING if has depends_on
    2. If PENDING: sdkClientManager.createSession() → session
    3. processRegistry.register() — track PID/AbortController
    4. sdkSessionAdapter.bind(taskId, session) — subscribe to events
    5. session.sendMessage(prompt) — starts execution
  → sdk-session-adapter.ts:
    - Streams SessionEvent → taskManager.appendOutput/updateTask
    - On session.completed → COMPLETED
    - On session.error (429/5xx) → attempt rotation via callback
    - On session.shutdown → finalize metrics, update status
```

### Session-to-Task ID Mapping

Session IDs are set to the task ID at creation time, but after rotation rebind the session gets a new ID. The `sdk-client-manager.ts` maintains a `sessionOwners` map (sessionId → taskId) so that sweepers, zombie detectors, and question cleanup resolve the correct task regardless of rebinds.

### Token Rotation

```
account-manager.ts (round-robin):
  Token A → Token B → Token C → Token A → ...

  On failure: mark token with failedAt, 60s cooldown
  On rotation: skip tokens in cooldown, auto-reset stale failures (>5min)
  All exhausted → trigger Claude fallback (if enabled)
```

Rotation can happen mid-session. The spawner destroys the old session, creates a new one on the next token, and `sdk-session-adapter.ts` rebinds with `rebindWithNewSession()` — preserving turn count, token totals, tool metrics, and output buffer.

### Process Kill Escalation

```
processRegistry.killTask(taskId):
  1. session.abort() with 5s timeout (if SDK session)
  2. abortController.abort() (if fallback session)
  3. SIGTERM to PID (if valid PID)
  4. Wait 3 seconds
  5. SIGKILL if still alive
  6. Remove from registry
```

The registry supports entries without PIDs (Claude fallback sessions have only an AbortController). `hasValidPid()` guards all signal operations.

### Template System (Matryoshka)

Templates are `.mdx` files loaded once and cached in a Map.

```
applyTemplate("super-coder", userPrompt, "typescript"):
  1. Load base: super-coder.mdx
  2. Load overlay: overlays/coder-typescript.mdx
  3. Inject overlay before "## BEGIN" section
  4. Filter TOOLKIT table rows if MCP_ENABLED_TOOLS is set
  5. Replace {{user_prompt}} with the user's prompt
```

Overlays add language/domain-specific instructions without duplicating the base template.

### Persistence

```
task-persistence.ts:
  Storage: ~/.super-agents/{md5(cwd)}.json
  Format: { version: 2, tasks: [...], cooldowns: [...] }
  Write: atomic temp file → fsync → rename (POSIX atomic)
  Dirty check: length + charCode hash to skip redundant writes
  Recovery: RUNNING/PENDING → FAILED on restart, RATE_LIMITED preserved
```

Output files live at `{cwd}/.super-agents/{task-id}.output`. These are separate from persistence — persistence stores task state, output files store verbose execution logs.

### Input Validation (Zod v4)

All tool inputs are validated with Zod schemas in `src/utils/sanitize.ts`. Shared field schemas are reused across roles:

- `sharedTimeoutSchema` — int, min 1s, max 1hr, default 30min
- `sharedModelSchema` — enum of `ALL_ACCEPTED_MODELS`
- `sharedDependsOnSchema` — array of non-empty strings
- `sharedLabelsSchema` — max 10 items, 50 chars each
- `contextFileSchema` — `{ path: string, description?: string }`

Per-role schemas (`SpawnCoderSchema`, `SpawnPlannerSchema`, etc.) extend these with role-specific fields. Coder requires min 1 context file; planner/researcher have no context file requirement.

### Brief Validation

`brief-validator.ts` enforces structural quality on prompts:

| Role | Min prompt length | Context files required | .md extension required |
|---|---|---|---|
| coder | 1000 chars | Yes (min 1) | Yes |
| planner | 300 chars | No | No |
| tester | 300 chars | Yes (min 1) | No |
| researcher | 200 chars | No | No |

File limits: max 20 files, 200KB each, 500KB total. Files must exist and be readable.

---

## Task State Machine

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
                                   └──→ FAILED (max retries exceeded)
```

Legal transitions are enforced by `VALID_TRANSITIONS` map. Illegal transitions are logged and rejected — the update is silently dropped, not thrown.

Terminal statuses: `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. Once terminal, no further status changes are accepted.

Internal statuses map to MCP task statuses: `working`, `input_required` (when pendingQuestion is set), `completed`, `failed`, `cancelled`.

### Dependency Validation

Dependencies are validated with DFS cycle detection at both spawn time and runtime:

- `findCircularDependencyPath()` returns the full cycle (e.g., `a → b → c → a`)
- Terminal tasks are treated as leaf nodes (completed deps don't create false cycles)
- Self-dependencies and duplicate dep IDs are rejected
- Missing dep IDs are rejected with a hint to check `task:///all`
- `processWaitingTasks()` re-checks for runtime deadlocks on every status change

### Retry (Exponential Backoff)

```
retry-queue.ts:
  Schedule: 5min → 10min → 20min → 40min → 60min → 120min
  Max retries: 6
  Jitter: 0–60s random (prevents thundering herd)
  Smart timing: uses SDK quotaInfo.resetDate when available
```

---

## MCP Resources

| URI | Content |
|-----|---------|
| `system:///status` | Account stats, SDK health, task counts |
| `task:///all` | All tasks with status, progress, pending questions |
| `task:///{id}` | Full task detail, output tail, metrics |
| `task:///{id}/session` | Execution log with tool calls and turn data |

Clients can subscribe to any URI for real-time notifications (debounced to max 1/sec per task). The server notifies on output, status change, and question events.

---

## Limits

| Limit | Value | Behavior when exceeded |
|---|---|---|
| Max in-memory tasks | 100 | Evicts oldest terminal tasks; if all 100 are active, spawn returns error |
| Max output lines per task | 2,000 | Oldest lines trimmed in-place via splice |
| Max context files per spawn | 20 files | Zod validation rejects |
| Max file size per context file | 200KB | Brief validator rejects |
| Max total context size | 500KB | Brief validator rejects |
| Max PAT tokens | 100 | account-manager ignores extras |
| Max labels per task | 10 (50 chars each) | Zod validation rejects |
| Question timeout | 30 minutes | Promise rejects, task may fail |
| Cleanup interval | 5 minutes | Removes expired terminal tasks (> TTL) |
| Health check interval | 10 seconds | Timeout enforcement, stall detection |
| Stale session sweep | 60 seconds | Destroys orphaned SDK sessions |
| Stale file handle age | 5 minutes | Output file handles closed to free FDs |
| PTY FD recycle threshold | 80 ptmx FDs | Triggers CopilotClient recycling |

---

## Gotchas

- **stdout must be clean** — All logging is `console.error`. A single `console.log` will corrupt MCP STDIO framing.
- **super-planner always uses Opus** — `resolveModel()` ignores the model parameter for planner; always returns `claude-opus-4.6`.
- **Session ID != Task ID after rotation** — After a token rotation rebind, the session gets a new ID. Use `sdkClientManager.sessionOwners` to resolve taskId from sessionId. Never assume they're equal.
- **TCP mode, not stdio** — `sdk-client-manager.ts` creates CopilotClient with `useStdio: false` (TCP) to avoid macOS stdio pipe race conditions.
- **In-place mutation** — `updateTask()` uses `Object.assign`, not spread. Creating a new object would break `appendOutput()` references. Never do `this.tasks.set(id, { ...task, ...updates })`.
- **Version from package.json** — `src/index.ts` reads version at runtime via `createRequire`. No manual sync needed.
- **Two `.super-agents/` locations** — Persistence: `~/.super-agents/{md5(cwd)}.json`. Output files: `{cwd}/.super-agents/{task-id}.output`.
- **Unhandled errors are non-fatal** — The server catches unhandled rejections and uncaught exceptions to keep MCP transport alive. Only OOM crashes the process.
- **Build copies .mdx files** — `tsc` only compiles `.ts`. The build script copies `.mdx` templates to `build/templates/` and `build/templates/overlays/`. If you add/rename templates, update the build script.
- **`(part as any)` casts in claude-code-runner.ts** — The AI SDK provider types changed between versions. Stream part properties (`delta`, `toolName`, `toolCallId`, `finishReason`, `isError`, `warnings`) are accessed via `(part as any)` because the type union doesn't expose them consistently. Don't try to remove the casts without verifying against the actual SDK version.
- **No `console.log` — really** — Even in debugging. Use `console.error` or write to the output file. This is the most common cause of "MCP connection broken" bugs.

---

## Additional Documentation

- `docs/ARCHITECTURE.md` — detailed system architecture with state diagrams and protocol flow
- `README.md` — user guide, quick start, tool reference, workflows, troubleshooting
