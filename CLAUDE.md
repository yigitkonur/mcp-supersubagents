# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server for spawning and managing parallel AI sub-agents via GitHub Copilot SDK (primary) with automatic fallback to Claude Agent SDK. Exposes 8 MCP tools for task orchestration with dependency chaining, multi-account PAT rotation, and specialized agent templates (coder, planner, researcher, tester). Node.js >= 18.0.0.

## Build & Run

```bash
npm run build       # tsc --noEmitOnError false + copy .mdx templates to build/
npm run dev         # tsx watch for hot-reload
npm start           # node build/index.js
npm run clean       # remove build/
npm run mcp:smoke   # MCP stdio protocol smoke test
```

Note: `--noEmitOnError false` means the build succeeds even with TypeScript errors.

Transport modes:
```bash
npx mcp-supersubagents                          # STDIO (default)
MCP_TRANSPORT=http npx mcp-supersubagents       # HTTP Streamable (default port 3000)
MCP_TRANSPORT=http MCP_PORT=8080 npx mcp-supersubagents
```

HTTP endpoints: `/mcp` (main), `/health` (health check). Sessions managed via `mcp-session-id` header.

Binary names: `mcp-supersubagents`, `copilot-mcp-server`, `super-subagents`.

Tests in `tests/` are manual scripts (no test runner configured): `mcp-test.ts`, `mcp-test-comprehensive.ts`, `mcp-test-multitoken.ts`.

## Environment Variables

**PAT tokens** (checked in priority order):
1. `GITHUB_PAT_TOKENS` — comma-separated list
2. `GITHUB_PAT_TOKEN_1`, `GITHUB_PAT_TOKEN_2`, ... — numbered
3. `GH_PAT_TOKEN` — comma-separated fallback
4. `GITHUB_TOKEN` / `GH_TOKEN` — single token

If no PAT token is configured, tasks immediately use Claude Agent SDK instead of Copilot.

**Feature flags:**
- `ENABLE_OPUS` — show claude-opus-4.6 in tool descriptions (default: false)
- `DISABLE_CLAUDE_CODE_FALLBACK` — disable auto-fallback to Claude Agent SDK (default: false)

**Timeouts** (all in ms, configured in `src/config/timeouts.ts`):
- `MCP_TASK_TIMEOUT_MS` — default task timeout (default: 1,800,000 / 30min)
- `MCP_TASK_TIMEOUT_MIN_MS` — minimum timeout (default: 1,000 / 1s)
- `MCP_TASK_TIMEOUT_MAX_MS` — max timeout (default: 3,600,000 / 1hr)
- `MCP_TASK_STALL_WARN_MS` — no-output warning threshold (default: 300,000 / 5min)
- `MCP_TASK_TTL_MS` — task retention after completion (default: 3,600,000 / 1hr)

**Copilot SDK:**
- `COPILOT_PATH` — path to Copilot CLI binary (default: `/opt/homebrew/bin/copilot`)
- `DEBUG_SDK_EVENTS` — log all SDK events (default: false)

## Architecture

```
src/
├── index.ts                    # MCP server init, tool registration, protocol handling
├── types.ts                    # TaskState, TaskStatus, and all shared interfaces
├── models.ts                   # Model configuration (Sonnet, Opus, Haiku)
├── copilot-sdk.d.ts            # Module augmentation for @github/copilot-sdk types
├── config/
│   └── timeouts.ts             # Centralized timeout config with env overrides
├── services/                   # Core service layer (17 files)
│   ├── task-manager.ts         # Central state machine: PENDING→WAITING→RUNNING→COMPLETED/FAILED
│   ├── account-manager.ts      # Round-robin PAT rotation with 60s cooldown on failure (max 100 tokens)
│   ├── sdk-spawner.ts          # Creates Copilot SDK sessions, detects rate limits
│   ├── sdk-session-adapter.ts  # Maps SDK events → TaskState updates
│   ├── sdk-client-manager.ts   # CopilotClient instances per workspace (TCP mode, not stdio)
│   ├── claude-code-runner.ts   # Claude Agent SDK executor (fallback path)
│   ├── exhaustion-fallback.ts  # Policy: when to activate Claude fallback
│   ├── session-snapshot.ts     # Extracts bounded context for fallback handoff
│   ├── retry-queue.ts          # Exponential backoff (5min→2hr, 6 retries: 5/10/20/40/60/120 min)
│   ├── task-persistence.ts     # Atomic writes to ~/.super-agents/{md5(cwd)}.json
│   ├── output-file.ts          # Streams output to {cwd}/.super-agents/{task-id}.output
│   ├── question-registry.ts    # Tracks pending ask_user questions (30min timeout, then rejects)
│   ├── progress-registry.ts    # Real-time MCP progress notifications
│   ├── subscription-registry.ts # Resource subscription tracking
│   ├── task-status-mapper.ts   # Internal TaskStatus → MCP Task mapping
│   ├── client-context.ts       # Workspace root discovery & default cwd
│   └── session-hooks.ts        # SDK event hooks (message, error, shutdown)
├── tools/                      # 8 MCP tool handlers
│   ├── spawn-coder.ts          # Coding tasks (min 1000 char prompt, requires .md context files)
│   ├── spawn-planner.ts        # Planning/architecture (min 300 chars, always uses Opus model)
│   ├── spawn-tester.ts         # Testing/QA (min 300 chars, requires context files)
│   ├── spawn-researcher.ts     # Research (min 200 chars)
│   ├── spawn-task.ts           # Generic spawn (legacy)
│   ├── send-message.ts         # Resume completed task with follow-up
│   ├── cancel-task.ts          # Cancel one or all tasks
│   ├── answer-question.ts      # Respond to pending ask_user questions
│   └── shared-spawn.ts         # Shared spawn logic for all specialized tools
├── templates/                  # Agent system prompts (.mdx)
│   ├── index.ts                # Template loading & matryoshka composition
│   ├── super-coder.mdx         # Coder agent system prompt
│   ├── super-planner.mdx       # Planner agent system prompt
│   ├── super-researcher.mdx    # Researcher agent system prompt
│   ├── super-tester.mdx        # Tester agent system prompt
│   └── overlays/               # Language/domain specialization overlays
│       ├── coder-typescript.mdx, coder-python.mdx
│       └── planner-feature.mdx, planner-bugfix.mdx, planner-migration.mdx
└── utils/
    ├── brief-validator.ts      # Validates spawn prompts & context file requirements
    ├── task-id-generator.ts    # Human-readable IDs: {adjective}-{animal}-{number}
    ├── format.ts               # MCP response formatting
    └── sanitize.ts             # Zod v4 schemas for all spawn tool inputs
```

**Key flows:**
- **Spawn** → `shared-spawn.ts` validates brief → `task-manager.ts` creates task → resolves dependencies (with circular dependency detection) → `sdk-spawner.ts` creates Copilot session → `sdk-session-adapter.ts` streams events to TaskState
- **Rate limit** → `account-manager.ts` rotates to next PAT (round-robin, 60s cooldown) → if all exhausted → `exhaustion-fallback.ts` triggers → `session-snapshot.ts` extracts context → `claude-code-runner.ts` takes over
- **Persistence** → tasks written to `~/.super-agents/{md5(cwd)}.json` (atomic temp+rename) → on restart, RUNNING/PENDING tasks marked FAILED, RATE_LIMITED tasks preserved for auto-retry

**Task lifecycle:** `PENDING → WAITING (if depends_on) → RUNNING → COMPLETED | FAILED | CANCELLED | TIMED_OUT | RATE_LIMITED (→ auto-retry)`

## MCP Resources

The server exposes MCP Resources (queryable/subscribable):

| URI | Content |
|-----|---------|
| `system:///status` | Account stats, SDK health, task counts |
| `task:///all` | All tasks with status, progress, pending questions |
| `task:///{id}` | Full task detail, output tail, metrics, quota info |
| `task:///{id}/session` | Execution log with tool calls and turn data |

## Template System

Agent prompts use a matryoshka pattern: base template (e.g., `super-coder.mdx`) + optional specialization overlay (e.g., `overlays/coder-typescript.mdx`). Overlay is injected before the `## BEGIN` section. User prompt replaces `{{user_prompt}}` placeholder.

Templates reference `.agent-workspace/plans/`, `.agent-workspace/researches/`, `.agent-workspace/implementation/` for inter-agent file handoff.

## Limits

- Max in-memory tasks: 100 (oldest terminal tasks evicted)
- Max output lines per task: 2,000 (older lines trimmed)
- Max context files per spawn: 20 files, 200KB each, 500KB total
- Max PAT tokens: 100
- Max labels per task: 10 (50 chars each)
- Question timeout: 30 minutes (then Promise rejects, task may fail)
- Cleanup interval: 5 minutes (removes expired terminal tasks)
- Health check interval: 10 seconds (detects stalled sessions)
- Stale session sweep: 60 seconds
- PTY FD recycle threshold: 80 ptmx FDs triggers client recycling

## Gotchas

- **Version mismatch** — `src/index.ts` hardcodes `version: '1.4.0'` but package.json says `1.4.1`. Update index.ts when bumping version.
- **super-planner always uses Opus** — model parameter is ignored; always resolves to claude-opus-4.6.
- **Session ID = Task ID** — Copilot session ID is set to the task ID for easy mapping.
- **TCP mode** — `sdk-client-manager.ts` creates CopilotClient with `useStdio: false` (TCP) to avoid macOS stdio pipe race conditions.
- **Stdout must be clean** — STDIO transport is default; all logging uses `console.error` (stderr). Any stdout pollution corrupts MCP protocol.
- **Unhandled errors are non-fatal** — the server catches unhandled rejections and uncaught exceptions to keep MCP transport alive. Only OOM crashes the process.
- **Two `.super-agents/` locations** — persistence: `~/.super-agents/{md5(cwd)}.json`, output: `{cwd}/.super-agents/{task-id}.output`.

## Additional Documentation

- `docs/ARCHITECTURE.md` — detailed system architecture, state machines, protocol flow
- `FALLBACK_IMPLEMENTATION.md` — Claude Agent SDK fallback implementation details
- `playwright-notes/` — 16 markdown guides for browser testing patterns (reference for tester agent)
- `README.md` — user guide, quick start, tool reference, workflows
