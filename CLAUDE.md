# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies (copilot-sdk is a local file dep at ./copilot-sdk/nodejs)
npm run build        # Compile TypeScript to build/ (also need to copy *.mdx: cp src/templates/*.mdx build/templates/)
npm run dev          # Watch mode with tsx (auto-reload)
npm start            # Run compiled server (requires build first)
npm run clean        # Remove build directory
```

**Build note:** `tsc` only compiles `.ts` files. After `npm run build`, you must also run `cp src/templates/*.mdx build/templates/` to copy template files. The `@github/copilot-sdk` is a local dependency (`file:./copilot-sdk/nodejs`). If `copilot-sdk/nodejs/dist/` is missing, build it first: `cd copilot-sdk/nodejs && npm install && npm run build`.

**Known type errors:** There are pre-existing `TS2345` errors in `sdk-spawner.ts` (lines 42/51, `task.cwd` is `string | undefined` vs `string`) and some type-only import mismatches against the SDK. These are safe at runtime since type imports are erased. Use `npx tsc --noEmitOnError false` if needed to emit JS despite type errors.

## Architecture Overview

This is an MCP server that manages GitHub Copilot agents as autonomous SDK sessions. It provides task orchestration, multi-account PAT rotation for rate limit recovery, dependency chains, and session lifecycle management over the MCP protocol.

The server exposes 4 MCP tools, MCP resources for task state, and MCP task lifecycle endpoints. Clients (Claude Code, VS Code, etc.) interact exclusively through the MCP protocol over stdio.

### Directory Structure

```
src/
├── index.ts                     # MCP server setup, tool/resource/task handlers, lifecycle wiring (649 lines)
├── types.ts                     # All shared types: TaskState, TaskStatus, SpawnOptions, SessionMetrics, etc. (284 lines)
├── models.ts                    # Model registry (sonnet/opus/haiku), ENABLE_OPUS gating (24 lines)
├── config/
│   └── timeouts.ts              # Timeout constants with env var overrides (17 lines)
├── services/
│   ├── sdk-spawner.ts           # Top-level task spawning, error classification, rate limit handling (494 lines)
│   ├── sdk-client-manager.ts    # CopilotClient pool per workspace+token, session create/resume/destroy (408 lines)
│   ├── sdk-session-adapter.ts   # Binds SDK sessions to tasks, handles events, rotation, metrics (1,104 lines)
│   ├── session-hooks.ts         # SDK SessionHooks for lifecycle (start/end/error/tool) logging (171 lines)
│   ├── task-manager.ts          # Central state machine: lifecycle, dependencies, persistence, cleanup (830 lines)
│   ├── task-persistence.ts      # Atomic JSON persistence to ~/.super-agents/{hash}.json (176 lines)
│   ├── task-status-mapper.ts    # Maps 8-state internal model → MCP 4-state model + status messages (288 lines)
│   ├── account-manager.ts       # Multi-account PAT rotation (round-robin, cooldown, failover) (302 lines)
│   ├── question-registry.ts     # SDK ask_user → MCP bridge: stores pending questions, resolves answers (336 lines)
│   ├── retry-queue.ts           # Exponential backoff for rate-limited tasks (5m → 2h) (232 lines)
│   ├── progress-registry.ts     # Throttled MCP progress notifications per task (123 lines)
│   ├── subscription-registry.ts # MCP resource subscription tracking (task:/// URIs) (33 lines)
│   ├── client-context.ts        # Stores client workspace roots from MCP initialization (49 lines)
│   └── output-file.ts           # Live output files at {cwd}/.super-agents/{taskId}.output (97 lines)
├── tools/
│   ├── spawn-task.ts            # spawn_task: create new agent tasks with template+model selection (159 lines)
│   ├── cancel-task.ts           # cancel_task: cancel one or all tasks (supports "all" keyword) (181 lines)
│   ├── send-message.ts          # send_message: send follow-up messages to existing sessions (178 lines)
│   └── answer-question.ts       # answer_question: respond to SDK ask_user questions (140 lines)
├── templates/
│   ├── index.ts                 # Template registry and {{user_prompt}} substitution (37 lines)
│   ├── super-coder.mdx          # Coding: "think 10 times, write once" — search→think→plan→implement→verify (518 lines)
│   ├── super-planner.mdx        # Planning: evidence-based design with codebase exploration mandate (557 lines)
│   ├── super-researcher.mdx     # Research: multi-angle investigation with source authority ranking (393 lines)
│   ├── super-tester.mdx         # Testing: "test like a user, not a developer" — E2E > integration > unit (687 lines)
│   ├── super-questioner.mdx     # Forces ask_user before proceeding (13 lines)
│   └── super-arabic.mdx         # Arabic-language agent (8 lines)
└── utils/
    ├── sanitize.ts              # Zod schemas for tool input validation (20 lines)
    ├── format.ts                # MCP response formatting: mcpText, formatError, formatTable (38 lines)
    └── task-id-generator.ts     # Human-readable IDs: brave-tiger-42 (25 lines)
```

### Request Flow (spawn_task)

1. `spawn-task.ts:85` validates input via Zod, applies template from `templates/index.ts:25`
2. `sdk-spawner.ts:67` creates `TaskState` via `taskManager.createTask()`, then calls `runSDKSession()` via `setImmediate`
3. `sdk-client-manager.ts` gets/creates a `CopilotClient` for the workspace+token, creates a `CopilotSession` with hooks
4. `sdk-session-adapter.ts` binds the session to the task, subscribing to all SDK `SessionEvent`s
5. `session.sendAndWait({ prompt }, timeout)` runs the prompt; adapter handles events (output, errors, tool calls, usage, subagents)
6. On completion/error, `task-manager.ts` transitions state via `updateTask()` and triggers side effects

### Key Architectural Patterns

**Singleton services:** Most services export a singleton instance (`taskManager`, `sdkClientManager`, `sdkSessionAdapter`, `accountManager`, `questionRegistry`, `progressRegistry`, `subscriptionRegistry`, `clientContext`). Import them directly; don't instantiate.

**Session binding:** `sdk-session-adapter.ts` maintains a `SessionBinding` per task that subscribes to SDK `SessionEvent`s. On rotation, it unbinds the old session and rebinds a new one. The binding tracks rotation attempts, timeout state, and whether rotation is in progress.

**TERMINAL_STATUSES:** Exported from `task-manager.ts` as a `Set` containing `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. `RATE_LIMITED` is intentionally NOT terminal — the retry system can still update these tasks. Always import from `task-manager.ts`; don't define locally.

**State transitions via updateTask():** Always use `taskManager.updateTask()` to change task state — never mutate `task.status` directly. `updateTask()` triggers: output file finalization, persistence scheduling, dependency resolution (`processWaitingTasks`), status change callbacks.

**Tool metrics tracking:** Handled exclusively by `sdk-session-adapter.ts` using `toolCallId`-based matching. `session-hooks.ts` only logs tool events; it does NOT track metrics (avoids duplicate writes to `task.sessionMetrics.toolMetrics`).

**Terminal state guards:** Both `sdk-session-adapter.ts` and `sdk-spawner.ts` check `isTerminalStatus()` before updating task state. This prevents race conditions where the adapter handles an error event and the spawner's `sendAndWait` also throws.

### Task Lifecycle

```
PENDING → RUNNING → COMPLETED
                  → FAILED
                  → CANCELLED (via cancel_task)
                  → TIMED_OUT (hard timeout or stall)
                  → RATE_LIMITED → (retry) → PENDING → ...
PENDING → WAITING (has unmet dependencies) → PENDING → RUNNING → ...
```

### Multi-Account Rotation

When a rate limit (429) or server error (5xx) occurs:

1. **Mid-session (adapter):** `sdk-session-adapter.ts` detects error event → calls `attemptRotationAndResume()` → rotates token via `accountManager` → health-checks new account → resumes session with `session.sendAndWait({ prompt: 'continue' })`
2. **Post-session (spawner):** `sdk-spawner.ts:278` catches `sendAndWait` exception → extracts status code → tries `rotateOnError()` → retries with new session
3. **All exhausted:** Falls back to exponential backoff via `retry-queue.ts` (5m → 10m → 20m → 40m → 1h → 2h, max 6 retries)

Tokens configured via env vars. Failed tokens enter 60s cooldown before reuse.

### SDK Question/Answer Flow

When the Copilot agent calls `ask_user`:
1. `sdk-client-manager.ts` `onUserInputRequest` handler fires
2. `question-registry.ts` stores the question, updates `task.pendingQuestion`, returns a Promise
3. MCP client sees pending question via resource `task:///{id}` or MCP notification
4. Client calls `answer_question` tool → registry resolves Promise → SDK resumes

Questions time out after 30 minutes.

### SDK Interface Notes

The `@github/copilot-sdk` (local at `./copilot-sdk/nodejs`) exports:
- **Values (runtime):** `CopilotClient`, `CopilotSession`, `defineTool`
- **Types (erased):** `SessionHooks`, `SessionConfig`, `SessionEvent`, `MessageOptions`, `UserInputRequest`, `UserInputResponse`, and all hook input/output types

Key SDK method signatures:
- `session.sendAndWait(options: MessageOptions, timeout?: number)` — `MessageOptions` requires `{ prompt: string }`, NOT a plain string
- `session.abort()` — Cancels session
- `session.destroy()` — Tears down session completely
- `SessionHooks` uses single handler functions (`onSessionStart`, `onSessionEnd`, `onErrorOccurred`, `onPreToolUse`, `onPostToolUse`), NOT arrays
- `PreToolUseHookOutput` uses `permissionDecision: 'allow' | 'deny'`, NOT `decision`
- `PostToolUseHookInput.toolResult.resultType` is `'success' | 'failure'` (camelCase, lowercase)
- `UsageMetricsTracker` is NOT exported by the SDK — do not try to import it as a value

## Key Types

- `TaskStatus` enum (8 states): `pending`, `waiting`, `running`, `completed`, `failed`, `cancelled`, `rate_limited`, `timed_out`
- `TaskState`: Full task state including `session`, `sessionMetrics`, `failureContext`, `pendingQuestion`, `outputFilePath`
- `SpawnOptions`: Input for `spawnCopilotTask()` — prompt, model, cwd, timeout, dependsOn, labels, etc.
- `SessionMetrics`: Aggregated metrics per session — quotas, tool metrics, subagents, turn count, token usage
- `FailureContext`: Structured error from SDK — errorType, statusCode, errorContext, recoverable flag
- `PendingQuestion`: Question from ask_user — question text, choices, allowFreeform, sessionId
- `ToolContext`: MCP request context with `progressToken` and `sendNotification`

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GITHUB_PAT_TOKENS` | — | Comma-separated PAT tokens for multi-account rotation |
| `GITHUB_PAT_TOKEN_1`..`_N` | — | Numbered PAT tokens (alternative to comma-separated) |
| `GH_PAT_TOKEN` | — | Fallback PAT token(s), comma-separated |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | Single token fallback |
| `ENABLE_OPUS` | `false` | Allow claude-opus-4.5 model (cost control) |
| `MCP_TASK_TIMEOUT_MS` | `1800000` (30m) | Default task timeout |
| `MCP_TASK_TIMEOUT_MIN_MS` | `1000` | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` (1h) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | `300000` (5m) | Stall warning threshold |

## MCP Resources

Tasks are exposed as MCP resources with URI scheme `task:///`:
- `system:///status` — Account stats, task counts, SDK info
- `task:///all` — List all tasks with status, progress, pending questions
- `task:///{taskId}` — Full task details, output, metrics
- `task:///{taskId}/session` — Execution log with tool calls

Clients can subscribe to resource URIs for real-time change notifications (debounced to max 1/sec per task).

## Adding New Tools

1. Create `src/tools/new-tool.ts` with:
   - A Zod schema for input validation
   - A tool definition object (`{ name, description, inputSchema }`)
   - A handler function `handleNewTool(args, context)`
2. Import and add to `tools` array and switch statement in `src/index.ts:166`

## Adding New Templates

1. Create `src/templates/super-newtype.mdx` with `{{user_prompt}}` placeholder
2. Add entry to `TASK_TYPES` in `src/templates/index.ts:7`
3. Rebuild (`npm run build && cp src/templates/*.mdx build/templates/`)

## Common Pitfalls

- **Never mutate task state directly.** Always go through `taskManager.updateTask()`. Direct mutation skips persistence, output finalization, and dependency processing.
- **TERMINAL_STATUSES is a Set, not an array.** Use `.has()`, not `.includes()`. Import it from `task-manager.ts`.
- **RATE_LIMITED is not terminal.** The retry system needs to update these tasks. Don't treat it as a final state.
- **Session cleanup on state transitions.** When a task leaves RUNNING (to RATE_LIMITED, FAILED, etc.), set `session: undefined` in the update. `updateTask()` handles this for terminal statuses and RATE_LIMITED.
- **Check terminal state before updating.** Both `sdk-session-adapter.ts` and `sdk-spawner.ts` must check `isTerminalStatus()` before writing — otherwise one overwrites the other's state transition.
- **Rotation attempts must be incremented.** Both reactive (error-triggered) and proactive (low-quota) rotation paths must increment `binding.rotationAttempts` to respect `maxRotationAttempts`.
- **Health check sessions must be cleaned up.** `sdk-session-adapter.ts` creates temporary sessions for health checks — destroy via `sdkClientManager.destroySession()`.
- **`handleEvent` in sdk-session-adapter is async.** Event listener callbacks must handle the returned promise with `.catch()`.
- **Tool metrics tracked by sdk-session-adapter only.** Uses `toolCallId`-based matching for accuracy. Don't add metrics tracking to `session-hooks.ts`.
- **`sendAndWait` takes `MessageOptions`, not a string.** Use `session.sendAndWait({ prompt: 'text' })`, never `session.sendAndWait('text')`.
- **`SessionHooks` uses single handlers.** Use `onPreToolUse: async (input) => { ... }`, not `preToolUse: [async (input) => { ... }]`.
- **Copy MDX files after build.** `tsc` doesn't copy `.mdx` files. Run `cp src/templates/*.mdx build/templates/` after each build.
- **Resumed sessions must be tracked.** When calling `sdkClientManager.resumeSession()`, the session is added to `entry.sessions` Map so it can be found for abort/destroy.
