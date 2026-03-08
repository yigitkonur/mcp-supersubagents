# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server that spawns and manages parallel AI sub-agents. Three execution backends are supported via a provider abstraction layer (`src/providers/`): OpenAI Codex (primary), GitHub Copilot SDK, and Claude Agent SDK (fallback). Provider selection order is configurable via `PROVIDER_CHAIN` (default: `codex,!claude-cli`). The server exposes 8 MCP tools (5 `launch-*` tools plus `message-agent`, `cancel-agent`, and `answer-agent`) over STDIO transport. Node.js >= 18.0.0.

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

If no PAT is configured, the server tries the next provider in the chain (Codex if `OPENAI_API_KEY` is set, then Claude).

### Provider chain

| Variable | Default | Effect |
|---|---|---|
| `PROVIDER_CHAIN` | `codex,!claude-cli` | Comma-separated provider IDs in selection order. Prefix `!` = fallback-only (skipped during primary selection, used only when earlier providers fail). |

### Feature flags

| Variable | Default | Effect |
|---|---|---|
| `MODEL_OVERRIDE` | (unset) | Force all requests to use this model (canonical name or alias). Overrides user-specified model. |
| `DISABLE_CLAUDE_CODE_FALLBACK` | `false` | Disable Claude Agent SDK in the provider chain |
| `DISABLE_CODEX_FALLBACK` | `false` | Disable Codex SDK in the provider chain |

### Timeouts (all in ms, defined in `src/config/timeouts.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TASK_TIMEOUT_MS` | 1,800,000 (30min) | Default task timeout |
| `MCP_TASK_TIMEOUT_MIN_MS` | 900,000 (15min) | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | 3,600,000 (1hr) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | 900,000 (15min) | No-output warning threshold |
| `MCP_TASK_TTL_MS` | 3,600,000 (1hr) | How long terminal tasks stay in memory |
| `BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS` | 15,000 (15s) | Max graceful shutdown wait |

### Copilot SDK

| Variable | Default | Purpose |
|---|---|---|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI binary |
| `DEBUG_SDK_EVENTS` | `false` | Log all SDK events to stderr |
| `MCP_ENABLED_TOOLS` | (unset = all) | Comma-separated tool names to keep in template TOOLKIT tables |

### Codex SDK

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` or `CODEX_API_KEY` | (optional*) | API key for Codex (*or use `codex auth` for CLI auth via `~/.codex/auth.json`) |
| `CODEX_PATH` | auto-detect | Override Codex CLI binary path |
| `CODEX_MODEL` | `o4-mini` | Default model for Codex tasks |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Sandbox: `read-only`, `workspace-write`, `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never` | Approval: `never`, `on-request`, `on-failure`, `untrusted` |
| `MAX_CONCURRENT_CODEX_SESSIONS` | `5` | Max simultaneous Codex sessions |

### Claude fallback

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_FALLBACK_MODEL` | `sonnet` | Override fallback model |
| `CLAUDE_FALLBACK_PERMISSION_MODE` | `bypassPermissions` | Claude permission mode |
| `CLAUDE_FALLBACK_MAX_TURNS` | `100` | Maximum agentic turns per session (1-100) |
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

Singletons: `taskManager`, `accountManager`, `sdkClientManager`, `sdkSessionAdapter`, `processRegistry`, `questionRegistry`, `progressRegistry`, `subscriptionRegistry`, `clientContext`, `providerRegistry`, `hookStateWriter`.

Services import each other's singletons directly. Circular dependencies are broken with lazy `await import()` inside methods (e.g., `task-manager.ts` imports `claude-code-runner.ts` lazily).

### Provider Abstraction Layer (`src/providers/`)

All AI backends implement the `ProviderAdapter` interface (`types.ts`). The `ProviderRegistry` singleton (`registry.ts`) manages registration, chain-based selection, and fallback routing.

| File | Purpose |
|---|---|
| `types.ts` | `ProviderAdapter`, `ProviderCapabilities`, `ProviderSpawnOptions`, `FallbackRequest`, `ChainEntry` |
| `registry.ts` | `providerRegistry` singleton — `register()`, `configureChain()`, `selectProvider()`, `selectFallback()` |
| `copilot-adapter.ts` | Wraps Copilot SDK (`sdk-spawner.ts`, `sdk-session-adapter.ts`, `sdk-client-manager.ts`) |
| `copilot-session-runner.ts` | Bridge: delegates `spawn()` to `executeWaitingTask()` in sdk-spawner |
| `claude-adapter.ts` | Wraps `claude-code-runner.ts` |
| `codex-adapter.ts` | Codex provider: app-server protocol (default) with SDK fallback (`@openai/codex-sdk`) |
| `codex-app-server.ts` | JSON-RPC client for the Codex app-server v2 protocol |
| `fallback-handler.ts` | Generic fallback: `triggerFallback()` walks chain for next available provider |
| `index.ts` | Public API re-exports |

Task creation is provider-agnostic (in `shared-spawn.ts`). Providers receive a `taskId` and handle only the RUNNING→COMPLETED|FAILED transitions.

### The Spawn Flow

```
MCP client calls spawn_agent
  → spawn-agent.ts: dispatch by role (coder/planner/tester/researcher)
  → shared-spawn.ts handleSharedSpawn():
    1. Zod schema.parse(args)
    2. validateBrief() — prompt length, context file existence/size
    3. assemblePromptWithContext() — reads context files, injects into prompt
    4. applyTemplate() — matryoshka: base.mdx + overlay.mdx + user prompt
    5. providerRegistry.selectProvider() — pick first available in chain
    6. taskManager.createTask() — PENDING or WAITING (provider-agnostic)
    7. setImmediate → provider.spawn() (returns task ID immediately)
  → Provider-specific execution:
    Copilot: copilot-session-runner.ts → executeWaitingTask() → runSDKSession()
    Codex:   codex-adapter.ts → app-server (thread/start + turn/start) or SDK fallback
    Claude:  claude-adapter.ts → runClaudeCodeSession()
  → On provider failure:
    triggerFallback() → providerRegistry.selectFallback() → next provider
```

### Mode Mapping (`mode` param, default: `fleet`)

| `mode` | Copilot SDK | Claude Code Fallback |
|---|---|---|
| `autopilot` | `rpc.mode.set('autopilot')` | `bypassPermissions` (no suffix prompt) |
| `plan` | `rpc.mode.set('autopilot')` + plan suffix prompt | `bypassPermissions` + plan suffix prompt |
| `fleet` | `rpc.mode.set('autopilot')` + `rpc.fleet.start()` + fleet suffix prompt | `bypassPermissions` + fleet suffix prompt |

Suffix prompts are defined in `src/config/mode-prompts.ts`. Resolution logic in `resolveMode()` (`src/services/sdk-spawner.ts`): explicit `mode` > `enableFleet` legacy > default `fleet`.

**Per-tool mode defaults:** coder=`fleet`, planner=`plan`, tester=`fleet`, researcher=`fleet`, classic=`autopilot`. The default only changes which suffix prompt is appended — all modes auto-execute.

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
Task created → providerRegistry.selectProvider() walks PROVIDER_CHAIN
  Default chain: copilot → codex → !claude-cli

  copilot selected:
    ├─ 429/5xx → rotate PAT token (up to 10 attempts per session)
    │   ├─ Rotation success → new session, rebind metrics, send handoff prompt
    │   └─ All exhausted → triggerFallback() → next in chain (codex or claude)
    └─ Quota <1% → proactive rotation before hard rate limit

  codex selected:
    ├─ Success → COMPLETED
    └─ Error → triggerFallback() → next in chain (claude)

  claude-cli selected:
    ├─ Success → COMPLETED
    └─ Error → FAILED (end of chain)

  No providers available → spawn fails immediately
```

`task.fallbackAttempted` is a single-flight guard — `triggerFallback` is a no-op if already true.

### Token Rotation

```
account-manager.ts (round-robin):
  Token A → Token B → Token C → Token A → ...
  On failure: mark token with failedAt, 60s cooldown
  Auto-heal: stale failures >5min cleared
  All exhausted → triggerFallback() → next provider in chain
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

### Proactive Task Notifications

Claude Code's MCP implementation has gaps that prevent standard notification paths from working reliably ([anthropics/claude-code#31893](https://github.com/anthropics/claude-code/issues/31893)):

- `notifications/tasks/status` — custom method, Claude Code has no handler
- `notifications/progress` — only works mid-tool-call with a progressToken
- `sendResourceUpdated` — requires client subscription, Claude Code rarely subscribes
- `sendResourceListChanged` — re-fetches the resource *list* but doesn't re-read individual resources

Two complementary workarounds are implemented together:

**Approach 1: Tool Description Hack + `list_changed`** (`src/services/tool-description-banner.ts`)

When a task reaches terminal status or asks a question, the server sends `notifications/tools/list_changed` (debounced 1s). Claude Code re-fetches the tool list. The `description` fields on `answer-agent` and `message-agent` are TypeScript getters that call `buildStatusBanner()` / `buildStatusBannerForAnswerAgent()` — returning the base description plus a live status footer (max 500 chars) showing running/completed/question-pending tasks. The banner is computed on-demand from `taskManager.getAllTasks()` and `questionRegistry.getAllPendingQuestions()`.

```
message-agent description footer:
---
AGENT STATUS: 2 running | 1 needs answer | 1 just completed
- abc123 [completed] coder (2min ago)  output: /path/.super-agents/abc123.output
- def456 [input_required] — waiting for answer
Read task:///all for full details.
```

**Approach 2: Hooks Bridge** (`src/services/hook-state-writer.ts` + `scripts/super-agents-hook.sh`)

The server writes task events to `{cwd}/.super-agents/hook-state.json`. A PostToolUse hook script reads unseen events (`seenAt: null`) and returns `{"additionalContext": "..."}`, which Claude Code injects into the conversation after every tool call. This provides mid-turn reactivity.

The hook state file uses a Map keyed by taskId (latest event wins), atomic writes (temp → fdatasync → rename), and stale event cleanup (seenAt + 1 hour). The bash script uses `jq` with `python3` fallback, runs in ~10ms.

```
Notification flow:
  Task completes/fails/asks question
    → onStatusChange / onQuestionAsked callbacks in index.ts
    → scheduleToolListChanged() — debounced, sends tools/list_changed
    → hookStateWriter.notifyStatusChange() / notifyQuestion() — writes hook-state.json
    → Next tool call: hook script reads unseen events → additionalContext injection
    → Next ListTools request: getter computes fresh banner from live state
```

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
| Max concurrent Codex sessions | 5 | Concurrency counter in codex-adapter |

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
- **`mode` controls all providers** — The `mode` enum (`fleet` | `plan` | `autopilot`, default: `fleet`) maps to all three providers. On Copilot: always `rpc.mode.set('autopilot')` + optional `rpc.fleet.start()` for fleet mode. On Claude: always `bypassPermissions` + mode-specific suffix prompt. Both always auto-run — `plan` mode doesn't block for approval. See mode mapping table below.
- **Autopilot RPC for all modes** — Copilot's native `plan` mode blocks for human approval via `ask_user`, which deadlocks headless execution. The spawner always sets `rpc.mode.set('autopilot')` and uses suffix prompts for behavioral differentiation. The systemMessage fallback is kept for older CLI versions. After token rotation, autopilot and fleet (if applicable) are re-applied on the new session.
- **`approveAll` from SDK** — The permission handler uses the SDK-exported `approveAll` helper for the default `allow_all` mode. Only the `safe` mode (`COPILOT_PERMISSION_MODE=safe`) uses a custom handler.
- **Claude fallback uses `bypassPermissions`** — Changed from `plan` for parity with Copilot's `approveAll` handler. Override with `CLAUDE_FALLBACK_PERMISSION_MODE=plan` if needed. Mode suffix prompts are appended to the fallback prompt for fleet/plan behavioral differentiation.
- **`autonomous` and `enable_fleet` are legacy** — Both remain in schemas for backward compatibility. `resolveMode()` in `sdk-spawner.ts` resolves: explicit `mode` > `enableFleet` legacy flag > default `fleet`. Setting `autonomous: false` has no effect on mode — all modes auto-run.
- **Tool descriptions are getters, not static strings** — `messageAgentTool.description` and `answerAgentTool.description` are TypeScript `get` accessors that compute a live status banner on every access. Do not convert them back to plain string properties — the banner is computed from `taskManager`/`questionRegistry` state at call time. The `McpToolDefinition` interface accepts this because getter properties satisfy `string` type.
- **`scheduleToolListChanged()` is debounced and `.unref()`'d** — Multiple rapid status changes produce a single `tools/list_changed` notification (1s debounce). The timer is `.unref()`'d so it doesn't prevent process exit. Cleared in the shutdown handler alongside other timers.
- **Hook state file is best-effort** — `hookStateWriter` uses swallow-tier error handling (log to stderr, never throw). The hook script also exits 0 on all error paths. Neither can block or crash the server.

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

- `docs/provider-abstraction/` — 8-part documentation of the provider abstraction layer, adapters, and migration guide
- `docs/ARCHITECTURE.md` — detailed system architecture with state diagrams and protocol flow
- `README.md` — user guide, quick start, tool reference, workflows, troubleshooting
- `REVIEW.md` — code review guidelines, security checklist, conventions, anti-patterns
- `AUDIT.md` — security audit findings and remediation
