# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies (copilot-sdk is a local file dep at ./copilot-sdk/nodejs)
npm run build        # Compile TypeScript to build/
npm run dev          # Watch mode with tsx (auto-reload)
npm start            # Run compiled server (requires build first)
npm run clean        # Remove build directory
```

**Build note:** `@github/copilot-sdk` is a local dependency (`file:./copilot-sdk/nodejs`). Build errors about `TS2307: Cannot find module '@github/copilot-sdk'` mean the SDK source isn't present. There are also two pre-existing `TS2345` errors in `sdk-spawner.ts` lines 42/51 (`task.cwd` is `string | undefined` vs `string`).

## Architecture Overview

This is an MCP (Model Context Protocol) server that manages GitHub Copilot agents as SDK sessions. It provides task orchestration, multi-account PAT rotation for rate limit recovery, dependency chains, and session lifecycle management over the MCP protocol.

The server exposes 4 MCP tools, MCP resources for task state, and MCP task lifecycle endpoints. Clients (e.g. Claude Code, VS Code) interact exclusively through the MCP protocol over stdio.

### Directory Structure

```
src/
├── index.ts                    # MCP server setup, tool/resource/task handlers, lifecycle wiring
├── types.ts                    # All shared types: TaskState, TaskStatus, SpawnOptions, SessionMetrics, etc.
├── models.ts                   # Model registry (sonnet/opus/haiku), ENABLE_OPUS gating
├── config/
│   └── timeouts.ts             # Timeout constants with env var overrides
├── services/
│   ├── sdk-spawner.ts          # Top-level task spawning, error classification, rate limit handling
│   ├── sdk-client-manager.ts   # CopilotClient pool per workspace+token, session create/resume/destroy
│   ├── sdk-session-adapter.ts  # Binds SDK sessions to tasks, handles events, rotation, metrics
│   ├── session-hooks.ts        # SDK QueryHooks for lifecycle (start/end/error/tool) logging
│   ├── task-manager.ts         # Central state machine: lifecycle, dependencies, persistence, cleanup
│   ├── task-persistence.ts     # Atomic JSON persistence to ~/.super-agents/{hash}.json
│   ├── task-status-mapper.ts   # Maps 8-state internal model → MCP 4-state model + status messages
│   ├── account-manager.ts      # Multi-account PAT rotation (round-robin, cooldown, failover)
│   ├── question-registry.ts    # SDK ask_user → MCP bridge: stores pending questions, resolves answers
│   ├── retry-queue.ts          # Exponential backoff for rate-limited tasks (5m → 2h)
│   ├── progress-registry.ts    # Throttled MCP progress notifications per task
│   ├── subscription-registry.ts# MCP resource subscription tracking (task:/// URIs)
│   ├── client-context.ts       # Stores client workspace roots from MCP initialization
│   └── output-file.ts          # Live output files at {cwd}/.super-agents/{taskId}.output
├── tools/
│   ├── spawn-task.ts           # spawn_task: create new agent tasks with template+model selection
│   ├── cancel-task.ts          # cancel_task: cancel one or all tasks (supports "all" keyword)
│   ├── send-message.ts         # send_message: send follow-up messages to existing sessions
│   └── answer-question.ts      # answer_question: respond to SDK ask_user questions
├── templates/
│   ├── index.ts                # Template registry and {{user_prompt}} substitution
│   ├── super-coder.mdx         # Coding task system prompt
│   ├── super-planner.mdx       # Planning/architecture system prompt
│   ├── super-researcher.mdx    # Research/investigation system prompt
│   └── super-tester.mdx        # QA/testing system prompt
└── utils/
    ├── sanitize.ts             # Zod schemas for tool input validation
    ├── format.ts               # MCP response formatting helpers (mcpText, formatError)
    └── task-id-generator.ts    # Human-readable IDs: brave-tiger-42
```

### Request Flow (spawn_task)

1. `spawn-task.ts` validates input via Zod, applies template, calls `spawnCopilotTask()`
2. `sdk-spawner.ts` creates a `TaskState` via `taskManager.createTask()`, then calls `runSDKSession()`
3. `sdk-client-manager.ts` gets/creates a `CopilotClient` for the workspace+token, creates a `CopilotSession` with hooks
4. `sdk-session-adapter.ts` binds the session to the task, subscribing to all SDK events
5. `session.sendAndWait()` runs the prompt; adapter handles events (output, errors, tool calls, usage, subagents)
6. On completion/error, `task-manager.ts` transitions state and triggers side effects (persistence, output file, dependency resolution)

### Key Architectural Patterns

**Singleton services:** Most services export a singleton instance (`taskManager`, `sdkClientManager`, `sdkSessionAdapter`, `accountManager`, `questionRegistry`, `progressRegistry`, `subscriptionRegistry`, `clientContext`).

**Session binding:** `sdk-session-adapter.ts` maintains a `SessionBinding` per task that subscribes to SDK `SessionEvent`s. On rotation, it unbinds the old session and rebinds a new one. The binding tracks rotation attempts, timeout state, and whether rotation is in progress.

**TERMINAL_STATUSES:** Exported from `task-manager.ts` as a `Set` containing `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. `RATE_LIMITED` is intentionally NOT terminal — the retry system can still update these tasks. Import from task-manager; don't define locally.

**State transitions via updateTask():** Always use `taskManager.updateTask()` to change task state — never mutate `task.status` directly. `updateTask()` triggers: output file finalization, persistence scheduling, dependency resolution (`processWaitingTasks`), status change callbacks.

**Tool metrics tracking:** Handled exclusively by `sdk-session-adapter.ts` using `toolCallId`-based matching. `session-hooks.ts` only logs tool events; it does NOT track metrics (to avoid duplicate/conflicting writes).

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

1. **Mid-session (adapter):** `sdk-session-adapter.ts` detects error event → calls `attemptRotationAndResume()` → rotates token via `accountManager` → health-checks new account → resumes session with `session.sendAndWait('continue')`
2. **Post-session (spawner):** `sdk-spawner.ts` catches `sendAndWait` exception → extracts status code → tries `rotateOnError()` → retries with new session
3. **All exhausted:** Falls back to exponential backoff via `retry-queue.ts`

Tokens configured via env vars (see below). Failed tokens enter 60s cooldown before reuse.

### SDK Question/Answer Flow

When the Copilot agent calls `ask_user`:
1. `sdk-client-manager.ts` `onUserInputRequest` handler fires
2. `question-registry.ts` stores the question, updates `task.pendingQuestion`, returns a Promise
3. MCP client sees pending question via resource `task:///{id}` or notification
4. Client calls `answer_question` tool → registry resolves Promise → SDK resumes

Questions time out after 30 minutes.

## Key Types

- `TaskStatus` enum: `pending`, `waiting`, `running`, `completed`, `failed`, `cancelled`, `rate_limited`, `timed_out`
- `TaskState`: Full task state including `session`, `sessionMetrics`, `failureContext`, `pendingQuestion`, `outputFilePath`
- `SpawnOptions`: Input for `spawnCopilotTask()` — prompt, model, cwd, timeout, dependsOn, labels, etc.
- `SessionMetrics`: Aggregated metrics per session — quotas, tool metrics, subagents, turn count, token usage
- `FailureContext`: Structured error from SDK — errorType, statusCode, errorContext, recoverable flag
- `PendingQuestion`: Question from ask_user — question text, choices, allowFreeform, sessionId

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI executable |
| `ENABLE_OPUS` | `false` | Allow opus model (cost control) |
| `GITHUB_PAT_TOKENS` | — | Comma-separated PAT tokens for multi-account rotation |
| `GITHUB_PAT_TOKEN_1`..`_N` | — | Numbered PAT tokens (alternative to comma-separated) |
| `GH_PAT_TOKEN` | — | Fallback PAT token(s), comma-separated |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | Single token fallback |
| `MCP_TASK_TIMEOUT_MS` | `1800000` (30m) | Default task timeout |
| `MCP_TASK_TIMEOUT_MIN_MS` | `1000` | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` (1h) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | `300000` (5m) | Stall warning threshold |

## MCP Resources

Tasks are exposed as MCP resources with URI scheme `task:///`:
- `task:///all` — List all tasks with status, metrics summary
- `task:///{taskId}` — Full task details, output, session metrics
- `task:///{taskId}/session` — Execution log with tool calls

Clients can subscribe to resource URIs for change notifications.

## Adding New Tools

1. Create `src/tools/new-tool.ts` with:
   - A Zod schema for input validation
   - A tool definition object (`{ name, description, inputSchema }`)
   - A handler function `handleNewTool(args, context)`
2. Import and add to `tools` array and switch statement in `src/index.ts`

## Common Pitfalls

- **Never mutate task state directly.** Always go through `taskManager.updateTask()`. Direct mutation skips persistence, output finalization, and dependency processing.
- **TERMINAL_STATUSES is a Set, not an array.** Use `.has()`, not `.includes()`. Import it from `task-manager.ts`.
- **RATE_LIMITED is not terminal.** The retry system needs to update these tasks. Don't treat it as a final state.
- **Session cleanup on state transitions.** When a task leaves RUNNING (to RATE_LIMITED, FAILED, etc.), ensure `session` is set to `undefined` in the update. `updateTask()` handles this for terminal statuses and RATE_LIMITED.
- **Rotation attempts must be incremented.** Both reactive (error-triggered) and proactive (low-quota) rotation paths must increment `binding.rotationAttempts` to respect `maxRotationAttempts`.
- **Health check sessions must be cleaned up.** `sdk-session-adapter.ts` creates temporary sessions for health checks — these must be destroyed via `sdkClientManager.destroySession()` to remove them from the tracking Map.
- **`handleEvent` in sdk-session-adapter is async.** Event listener callbacks must handle the returned promise with `.catch()`.
- **Tool metrics are tracked by sdk-session-adapter only.** Uses `toolCallId`-based matching for accuracy. Don't add metrics tracking to session-hooks.ts.
- **`@github/copilot-sdk` is a local file dependency.** It lives at `./copilot-sdk/nodejs`. TS2307 errors about this module mean the SDK source isn't checked out.
