<h1 align="center">🤖 Super Subagents 🤖</h1>

<h3 align="center">Stop waiting. Start spawning.</h3>

<p align="center">
  Spawn parallel autonomous AI agent sessions from a single MCP client. Each agent gets its own workspace, tools, and execution context. Your main session stays unblocked while agents code, plan, research, and test simultaneously.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-supersubagents"><img src="https://img.shields.io/npm/v/mcp-supersubagents?style=flat-square&color=cb3837&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/node/v/mcp-supersubagents?style=flat-square&color=339933&label=node" alt="node 18+">
  <a href="https://github.com/yigitkonur/mcp-supersubagents/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="platform">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/8_tools-ready_to_use-brightgreen?style=flat-square" alt="8 tools">
  <img src="https://img.shields.io/badge/⚡_parallel--spawn-unlimited_agents-orange?style=flat-square" alt="parallel spawn">
</p>

---

## Quick Navigation

[Get Started](#get-started) &#8226; [Why Super Subagents](#why-super-subagents) &#8226; [Tools](#tool-reference) &#8226; [Companion Tools](#companion-tools) &#8226; [Notifications](#proactive-notifications) &#8226; [Templates](#agent-templates) &#8226; [Configuration](#environment-variables) &#8226; [Examples](#recommended-workflows)

---

## The Pitch

AI coding assistants work one task at a time. You ask it to refactor a module, and you wait. Then you ask it to write tests, and you wait again. Then you ask it to update the docs. **Super Subagents multiplies your AI coding bandwidth.** Instead of sequential requests, spawn N agents that work simultaneously -- each with full tool access (file read/write, terminal, search) in its own isolated session. Three execution backends (OpenAI Codex, GitHub Copilot, Claude Agent SDK) with automatic failover.

<table>
<tr>
<td width="25%" align="center">

**⚡ Parallel Agents**

Spawn unlimited sessions. Each agent gets its own workspace, tools, and execution context.

</td>
<td width="25%" align="center">

**🔗 Task Dependencies**

Chain tasks with `depends_on`. Coder waits for planner. Tester waits for coder.

</td>
<td width="25%" align="center">

**🔄 Auto-Rotation**

Multi-account PAT rotation. Seamless mid-session recovery on 429/5xx errors.

</td>
<td width="25%" align="center">

**🎭 Agent Templates**

Specialized system prompts for coding, planning, research, and testing.

</td>
</tr>
</table>

### How It Works

```
You (main session):  "Spawn three tasks: refactor auth, write API tests, update the migration guide"

→ brave-tiger-42:    Refactoring auth module...          [running]
→ calm-falcon-17:    Writing API integration tests...    [running]
→ swift-panda-88:    Updating migration guide...         [running]

You:                 Continue working on other things — or spawn more tasks.
```

Each agent runs as an autonomous session in the background. When it finishes, you get [proactively notified](#proactive-notifications) — no polling needed. If it hits a rate limit, it rotates to another GitHub account automatically. Task IDs are human-readable (`brave-tiger-42`, `calm-falcon-17`) so you can track them at a glance.

---

## Why Super Subagents

| | Without Super Subagents | With Super Subagents |
|---|---|---|
| **Workflow** | Ask AI to refactor → wait → ask for tests → wait → ask for docs → wait | Spawn three agents at once, each works in parallel |
| **Tool access** | One session at a time | Each agent has full tool access (files, terminal, search) |
| **Rate limits** | Hit limit, wait manually | Auto-rotates to next account, resumes mid-session |
| **Progress** | Blocked until the one task finishes | Continue your own work, get notified when done |
| **Dependencies** | Manual sequencing | `depends_on` auto-chains tasks |
| **Context** | Shared session, context window fills up | Each agent gets a clean, focused context |

---

## Get Started

### Option 1: One-line install (recommended)

```bash
# Claude Desktop
npx install-mcp mcp-supersubagents --client claude-desktop

# Claude Code CLI
npx install-mcp mcp-supersubagents --client claude-code

# Cursor
npx install-mcp mcp-supersubagents --client cursor

# VS Code / Copilot
npx install-mcp mcp-supersubagents --client vscode

# Other clients: windsurf, cline, roo-cline, goose, zed, opencode, warp, codex, aider, gemini-cli
npx install-mcp mcp-supersubagents --client <client-name>
```

With environment variables for PAT tokens:

```bash
npx install-mcp mcp-supersubagents --client claude-desktop \
  --header "GITHUB_PAT_TOKENS: ghp_token1,ghp_token2"
```

### Option 2: Manual config

Add to your MCP client configuration:

<details>
<summary><strong>Claude Desktop</strong></summary>

File: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "super-agents": {
      "command": "npx",
      "args": ["-y", "mcp-supersubagents"],
      "env": {
        "GITHUB_PAT_TOKENS": "ghp_token1,ghp_token2"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Code CLI</strong></summary>

```bash
claude mcp add super-agents -- npx -y super-subagents
```

Set your PAT tokens as environment variables before launching:

```bash
export GITHUB_PAT_TOKENS="ghp_token1,ghp_token2"
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

File: `.cursor/mcp.json` in your project root

```json
{
  "mcpServers": {
    "super-agents": {
      "command": "npx",
      "args": ["-y", "mcp-supersubagents"],
      "env": {
        "GITHUB_PAT_TOKENS": "ghp_token1,ghp_token2"
      }
    }
  }
}
```

</details>

No build step required -- `npx` runs the package directly.

> **Note:** GitHub PAT tokens with Copilot access are recommended but not required. Without PATs, tasks automatically fall back to the Claude Agent SDK (requires `claude` CLI). For rate-limit resilience, configure multiple tokens via `GITHUB_PAT_TOKENS`. See [Multi-Account Rotation](#multi-account-rotation) for details.

---

## Tool Reference

Super Subagents exposes **8 MCP tools**: 5 specialized launchers + 3 utility tools.

<table>
<tr>
<td width="20%" align="center"><strong>🧑‍💻 launch-super-coder</strong><br>Code, fix, refactor</td>
<td width="20%" align="center"><strong>📋 launch-super-planner</strong><br>Architecture & plans</td>
<td width="20%" align="center"><strong>🔬 launch-super-researcher</strong><br>Investigate & analyze</td>
<td width="20%" align="center"><strong>🧪 launch-super-tester</strong><br>QA & testing</td>
<td width="20%" align="center"><strong>🔧 launch-classic-agent</strong><br>General purpose</td>
</tr>
</table>

<table>
<tr>
<td width="33%" align="center"><strong>💬 message-agent</strong><br>Follow-up on a task</td>
<td width="33%" align="center"><strong>🛑 cancel-agent</strong><br>Cancel one or all</td>
<td width="33%" align="center"><strong>❓ answer-agent</strong><br>Respond to agent</td>
</tr>
</table>

### Launch Tools

All 5 launch tools share these parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Complete self-contained instructions. Min length varies by role. |
| `context_files` | array | Varies | Files to inject into prompt. Each item: `{ path, description }`. Required for coder (min 1 .md) and tester (min 1). Max 20 files, 200KB each, 500KB total. |
| `model` | string | No | Model to use. Default: `gpt-5.4-xhigh`. See [Models](#models). |
| `cwd` | string | No | Absolute path to working directory |
| `depends_on` | string[] | No | Task IDs that must complete before this starts |
| `labels` | string[] | No | Labels for grouping/filtering (max 10) |

**Per-tool details:**

- **`launch-super-coder`** — Implementation tasks. Min 1000-char prompt + min 1 `.md` context file. Include: OBJECTIVE, FILES, CRITERIA, CONSTRAINTS, PATTERNS.
- **`launch-super-planner`** — Architecture/planning. Min 300-char prompt. Always uses `claude-opus-4.6`. Include: PROBLEM, CONSTRAINTS, SCOPE, OUTPUT.
- **`launch-super-researcher`** — Investigation. Min 200-char prompt. Include: TOPIC, QUESTIONS, HANDOFF TARGET.
- **`launch-super-tester`** — QA/testing. Min 300-char prompt + min 1 context file. Include: WHAT BUILT, FILES, CRITERIA, TESTS, EDGE CASES.
- **`launch-classic-agent`** — General-purpose agent. Min 200-char prompt. Use when a task doesn't fit the specialized roles.

```json
{
  "prompt": "Refactor the auth module to use JWT refresh tokens. Read /src/services/auth.ts for current implementation...",
  "context_files": [{ "path": "/path/to/plan.md" }],
  "labels": ["backend", "auth"]
}
```

**Recommended workflow:** researcher → planner → coder → tester. Chain with `depends_on`.

### `message-agent`

Send a follow-up message to a completed, failed, cancelled, rate-limited, or timed-out task's session. Resumes the same session so the agent retains full context of what it did.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | Task ID to send message to |
| `message` | string | No | Message to send. Default: `"continue"` |

```json
{ "task_id": "brave-tiger-42", "message": "Now add unit tests for the changes you made" }
```

### `cancel-agent`

Cancel one task, multiple tasks, or all tasks. Running/pending/waiting/rate-limited tasks are killed (SIGTERM). Completed/failed tasks are removed from memory. Duplicate IDs in an array are deduplicated automatically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string or string[] | Yes | Single ID, array of IDs (max 50), or `"all"` |
| `clear` | boolean | No | Required when `task_id="all"` |
| `confirm` | boolean | No | Required when `clear=true` |

```json
// Cancel one
{ "task_id": "brave-tiger-42" }

// Cancel many
{ "task_id": ["brave-tiger-42", "calm-falcon-17"] }

// Clear all
{ "task_id": "all", "clear": true, "confirm": true }
```

### `answer-agent`

Respond when an agent asks a question via `ask_user`. The task pauses until you answer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | Task ID with pending question |
| `answer` | string | Yes | Choice number (`"1"`, `"2"`), exact choice text, or `"CUSTOM: your answer"` |

```json
{ "task_id": "brave-tiger-42", "answer": "2" }
{ "task_id": "brave-tiger-42", "answer": "CUSTOM: Use TypeScript instead" }
```

---

## Resources

All status and monitoring is done through MCP resources (not polling):

| Resource URI | Content |
|---|---|
| `system:///status` | Account stats, task counts, SDK health |
| `task:///all` | All tasks with status, progress, pending questions |
| `task:///{id}` | Full task details: output, metrics, config |
| `task:///{id}/session` | Execution log: turns, tool calls, durations |

The server also implements the MCP Task primitive. Use `tasks/result` to retrieve filtered output. `isError` is `true` for any non-completed status (failed, cancelled, timed out, etc.):

```
→ tasks/result { taskId: "brave-tiger-42" }
← { content: [{ type: "text", text: "..." }], isError: false }
```

### Two-Tier Output

Output is split into two tiers to minimize token costs for callers:

| Tier | Destination | What's Included |
|------|-------------|-----------------|
| **Caller-facing** | In-memory (`task.output`), MCP resources, `tasks/result` | Agent text, turn markers (`--- Turn N ---`), significant tool calls (>100ms), errors, `[summary]` line |
| **Debug** | Output file only (`{cwd}/.super-agents/{id}.output`) | Everything above + `[reasoning]` blocks, `[usage]`/`[quota]` per turn, `[hooks]` lifecycle, `[session]` metadata, trivial tool calls |

This means **~90% fewer tokens** when reading task results via MCP, while full verbose output remains available in the file for debugging.

Clients can subscribe to resource URIs for real-time change notifications (debounced to max 1/sec per task). Each task also writes a live output file you can `tail -f`:

```bash
tail -f .super-agents/brave-tiger-42.output    # Follow live
tail -20 .super-agents/brave-tiger-42.output   # Last 20 lines
```

---

## Agent Templates

Templates wrap your prompt with specialized system instructions. The agent sees the template + your prompt, not your conversation.

| Template | Personality | Best For |
|---|---|---|
| `super-coder` | "Think 10 times, write once." Searches the codebase before touching anything. Verifies after every change. | Implementation, bug fixes, refactoring |
| `super-planner` | "Plan with evidence, not assumptions." Explores the codebase first, then designs atomic tasks with dependency graphs. | Architecture, design docs, task breakdown |
| `super-researcher` | "Find truth, not confirmation." Multi-angle investigation with source authority ranking. | Codebase exploration, technical questions |
| `super-tester` | "Test like a user, not a developer." E2E first, then integration, then unit. Collects evidence. | QA, test writing, verification |

```json
// launch-super-coder
{ "prompt": "Fix the null check in auth.ts line 45...", "context_files": [{ "path": "/path/to/plan.md" }] }
```

Each launch tool selects the corresponding agent template automatically.

---

## Models

| Model | Family | Reasoning | When to Use |
|---|---|---|---|
| `gpt-5.4-xhigh` | Codex | Maximum | **Default.** Best reasoning capability for complex tasks. |
| `gpt-5.4-high` | Codex | High | Good balance of reasoning and speed. |
| `gpt-5.4-medium` | Codex | Medium | Faster execution, suitable for straightforward tasks. |
| `gpt-5.3-codex-xhigh` | Codex | Maximum | Alternative Codex model with maximum reasoning. |
| `gpt-5.3-codex-medium` | Codex | Medium | Alternative Codex model, balanced. |
| `claude-sonnet-4.6` | Claude | — | Strong general capability. Runs on Claude CLI or Copilot. |
| `claude-opus-4.6` | Claude | — | Maximum capability. Used automatically by `launch-super-planner`. Set `ENABLE_OPUS=true` to show in tool descriptions. |

Reasoning effort is derived automatically from the model name — no need to specify it separately.

> **Note:** `launch-super-planner` always uses `claude-opus-4.6` regardless of the `model` parameter.

---

## Provider Chain

Tasks are routed through a configurable provider chain. The default order: **Codex → Copilot → Claude CLI (fallback-only)**.

```
PROVIDER_CHAIN=codex,copilot,!claude-cli   (default)
```

| Provider | Backend | Requires |
|---|---|---|
| `codex` | OpenAI Codex SDK | `OPENAI_API_KEY` |
| `copilot` | GitHub Copilot SDK | PAT token with Copilot access |
| `claude-cli` | Claude Agent SDK | `claude` CLI installed |

- Prefix `!` marks a provider as **fallback-only** (skipped during primary selection, used only when earlier providers fail).
- When a provider fails (rate limit, API error), the task automatically falls back to the next available provider in the chain.
- **Model-provider compatibility** is enforced: Claude models only route to `claude-cli` and `copilot`, not `codex`. If no compatible provider is available, the spawn fails with a clear error.

---

## Multi-Account Rotation

Configure multiple GitHub PAT tokens for automatic rate-limit recovery. When one account hits 429 or 5xx, the server rotates to the next token **mid-session without losing progress**.

### Configuration

```bash
# Comma-separated (recommended)
GITHUB_PAT_TOKENS=ghp_token1,ghp_token2,ghp_token3

# Or numbered
GITHUB_PAT_TOKEN_1=ghp_token1
GITHUB_PAT_TOKEN_2=ghp_token2

# Fallbacks (checked in order if above are empty)
GH_PAT_TOKEN=ghp_token
GITHUB_TOKEN=ghp_token
GH_TOKEN=ghp_token
```

### How it works

1. **Mid-session rotation:** When the SDK detects a rate limit during execution, it rotates to the next available token and resumes the session with full context.
2. **Post-session retry:** If the session fails after completion, the spawner tries another token and retries.
3. **All exhausted:** If all tokens are in cooldown, tasks enter exponential backoff via the retry queue.

| Mechanism | Detail |
|---|---|
| Token cooldown | 60 seconds after failure before reuse |
| Backoff schedule | 5m, 10m, 20m, 40m, 1h, 2h |
| Max retries | 6 |
| Triggers | HTTP 429 (rate limit), 5xx (server error) |

---

## Task Dependencies

Tasks can wait for other tasks using the `depends_on` field. The dependent task stays in `waiting` status until all dependencies complete, then auto-starts.

```json
{
  "prompt": "Deploy the service",
  "depends_on": ["build-task-id", "test-task-id"]
}
```

Dependencies are validated at spawn time:
- **Circular dependencies** are detected via DFS traversal. The error message includes the full cycle path (e.g., `a -> b -> c -> a`).
- **Self-dependencies** (a task depending on itself) are rejected.
- **Duplicate dependency IDs** are rejected.
- **Missing dependencies** (referencing a non-existent task ID) are rejected with a hint to check `task:///all`.
- **Runtime deadlock detection** — if a waiting task's dependencies form a cycle due to later state changes, the task is failed automatically with the cycle path.

### Example: Chained pipeline

```
launch-super-planner(prompt: "...") → plan-tiger-42    [running]
launch-super-coder(prompt: "...", depends_on: ["plan-tiger-42"])   → code-falcon-17   [waiting]
launch-super-tester(prompt: "...", depends_on: ["code-falcon-17"]) → test-panda-88    [waiting]

plan-tiger-42 completes → code-falcon-17 auto-starts
code-falcon-17 completes → test-panda-88 auto-starts
```

---

## Question Handling

When an agent calls `ask_user`, the task pauses and surfaces the question through MCP notifications and resources. Pending questions appear in `task:///all` and on the individual task resource.

### Answering

```json
// By choice number (1-indexed)
{ "task_id": "brave-tiger-42", "answer": "2" }

// By exact choice text
{ "task_id": "brave-tiger-42", "answer": "Use the existing database" }

// Custom freeform answer
{ "task_id": "brave-tiger-42", "answer": "CUSTOM: Use TypeScript instead" }
```

Questions time out after 30 minutes. The agent resumes automatically once you submit an answer.

---

## Proactive Notifications

MCP servers can send notifications when tasks complete or need attention, but Claude Code's current MCP implementation doesn't fully support the standard notification paths ([anthropics/claude-code#31893](https://github.com/anthropics/claude-code/issues/31893)). Super Subagents works around this with two complementary mechanisms that work together — no polling required.

### How you get notified

**1. Live status in tool descriptions (automatic)**

When a task completes or asks a question, the server triggers a tool list refresh. The `message-agent` and `answer-agent` tool descriptions include a live status footer showing what just happened:

```
message-agent description footer:
---
AGENT STATUS: 2 running | 1 needs answer | 1 just completed
- abc123 [completed] coder (2min ago)  output: .super-agents/abc123.output
- def456 [input_required] — waiting for answer
Read task:///all for full details.
```

```
answer-agent description footer:
---
ACTION REQUIRED — 1 task waiting for your answer:
- def456: "Which database?" Options: 1) PostgreSQL 2) MongoDB
Use answer-agent { "task_id": "def456", "answer": "1" }
```

This works out of the box — no configuration needed. Claude Code re-fetches tool descriptions automatically when the server signals `tools/list_changed`.

**2. Hooks bridge (opt-in, recommended)**

For mid-turn notifications (delivered after every tool call rather than waiting for the next turn), add a PostToolUse hook. The server writes task events to `{cwd}/.super-agents/hook-state.json`, and a bundled script reads unseen events and injects them as context.

**One-line setup:**

```bash
# From the repo / after npm install:
pnpm install-hooks        # or: bash scripts/install-hooks.sh

# After global npm install:
npx super-agents-install-hooks

# Check status without modifying anything:
bash scripts/install-hooks.sh --check

# Remove:
bash scripts/install-hooks.sh --uninstall
```

The installer checks your Claude Code environment, safely merges the hook into `~/.claude/settings.json` (preserving existing hooks), creates a backup, and reports status. Requires `jq`.

<details>
<summary>Manual setup (alternative)</summary>

Add to your Claude Code settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "command": "/path/to/node_modules/mcp-supersubagents/scripts/super-agents-hook.sh"
      }
    ]
  }
}
```
</details>

> **Requirements:** `jq` (preferred) or `python3` (fallback). The script runs in ~10ms and exits 0 on all error paths — it won't slow down or break your workflow.

When a task completes or asks a question, you'll see context injected after the next tool call:

```
[SUPER-AGENT COMPLETED] Task abc123 has completed. Output: .super-agents/abc123.output
[SUPER-AGENT QUESTION] Task def456 is asking: "Which database?" Options: 1. PostgreSQL, 2. MongoDB. Use answer-agent to respond.
```

### Why two approaches?

| | Tool Description Hack | Hooks Bridge |
|---|---|---|
| **Trigger** | On next `ListTools` request (next turn or tool call) | After every tool call (mid-turn) |
| **Setup** | Automatic, zero config | Requires hook configuration |
| **Best for** | Cross-turn awareness | Immediate mid-turn reactivity |

Both approaches are complementary. The tool description hack ensures Claude always sees current status when it considers which tools to call. The hooks bridge provides faster notification within a turn.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROVIDER_CHAIN` | `codex,copilot,!claude-cli` | Provider selection order. Prefix `!` = fallback-only. |
| `GITHUB_PAT_TOKENS` | -- | Comma-separated PAT tokens for multi-account rotation |
| `GITHUB_PAT_TOKEN_1`..`_N` | -- | Numbered PAT tokens (alternative to comma-separated) |
| `GH_PAT_TOKEN` | -- | Fallback PAT token(s), comma-separated |
| `GITHUB_TOKEN` / `GH_TOKEN` | -- | Single token fallback |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | -- | API key for Codex provider |
| `CODEX_MODEL` | `o4-mini` | Default model for Codex tasks |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` |
| `CODEX_USE_SDK` | `false` | Force legacy SDK mode instead of app-server protocol |
| `MAX_CONCURRENT_CODEX_SESSIONS` | `5` | Max simultaneous Codex sessions |
| `ENABLE_OPUS` | `false` | Show `claude-opus-4.6` in tool descriptions (opus is always usable via alias) |
| `DISABLE_CLAUDE_CODE_FALLBACK` | `false` | Disable automatic fallback to Claude Agent SDK |
| `DISABLE_CODEX_FALLBACK` | `false` | Disable Codex SDK in the provider chain |
| `MAX_CONCURRENT_CLAUDE_FALLBACKS` | `3` | Max simultaneous Claude sessions |
| `MCP_TASK_TIMEOUT_MS` | `1800000` (30 min) | Default task timeout |
| `MCP_TASK_TIMEOUT_MIN_MS` | `900000` (15 min) | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` (1 hr) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | `900000` (15 min) | No-output warning threshold |
| `DEBUG_NOTIFICATIONS` | `false` | Log MCP notification errors to stderr |
| `DEBUG_CLAUDE_FALLBACK` | `false` | Verbose logging for Claude Agent SDK fallback path |
| `DEBUG_SDK_EVENTS` | `false` | Log all Copilot SDK events |
| `BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS` | `15000` (15s) | Max wait time for graceful shutdown after broken pipe |

> **No API keys?** If neither PAT tokens nor `OPENAI_API_KEY` are configured, tasks automatically use the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-agent-sdk) as a fallback (requires `claude` CLI installed). Set `DISABLE_CLAUDE_CODE_FALLBACK=true` to prevent this.

---

## Recommended Workflows

### Parallel Feature Development

```
1. launch-super-coder({
     prompt: "Implement the /api/users endpoint. Read the OpenAPI spec at /docs/api.yaml for the schema...",
     context_files: [{ path: "/path/to/spec.md" }],
     labels: ["backend", "users-feature"]
   })
   → Task: brave-tiger-42

2. launch-super-tester({
     prompt: "Write E2E tests for the /api/users endpoint using the test patterns in /tests/...",
     context_files: [{ path: "/path/to/test-patterns.md" }],
     depends_on: ["brave-tiger-42"],
     labels: ["testing", "users-feature"]
   })
   → Task: calm-falcon-17 (waiting for brave-tiger-42)

3. launch-super-researcher({
     prompt: "Research best practices for user data pagination. Compare cursor vs offset...",
     labels: ["research", "users-feature"]
   })
   → Task: swift-panda-88 (starts immediately, runs in parallel with brave-tiger-42)

4. Continue your own work. MCP notifications arrive as tasks complete.

5. brave-tiger-42 completes → calm-falcon-17 auto-starts (dependencies satisfied)

6. Review results:
   - Read resource: task:///all
   - tail -20 .super-agents/brave-tiger-42.output
   - message-agent({ task_id: "brave-tiger-42", message: "Add input validation" })
```

### Plan-Code-Test Pipeline

```
1. launch-super-planner(...)  → Creates architecture plan with builder-briefing.md
2. launch-super-coder(...)    → depends_on planner, uses briefing as context_file
3. launch-super-tester(...)   → depends_on coder, uses tester-checklist.md as context_file
```

Each stage auto-starts when its dependencies complete. The planner always uses `claude-opus-4.6` for maximum reasoning quality.

---

## Task Lifecycle

```
pending → running → completed
                  → failed
                  → cancelled
                  → timed_out
                  → rate_limited → (auto-retry) → pending → running → ...

pending → waiting (dependencies) → pending → running → ...
pending / waiting → timed_out    (if timeout expires before execution starts)
pending / waiting → cancelled
pending / waiting → failed       (e.g. missing or circular dependencies)
```

Eight internal states map to five MCP states (`working`, `input_required`, `completed`, `failed`, `cancelled`) for clients that use MCP task primitives.

### Limits

- Max in-memory tasks: **100** (oldest terminal tasks evicted; if all 100 are active, spawn returns an actionable error)
- Max output lines per task: **2,000** (older lines trimmed in-place)

### Persistence

Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Survives server restarts. Rate-limited tasks auto-retry on reconnect. Output files persist in `{cwd}/.super-agents/` for post-hoc review.

---

## Development

```bash
# Clone
git clone https://github.com/yigitkonur/mcp-supersubagents.git
cd mcp-supersubagents

# Install dependencies
pnpm install
# Build (TypeScript + copy MDX templates)
pnpm build

# Watch mode (auto-reload)
pnpm dev

# Run the compiled server
pnpm start
```

> **Build note:** `tsc` only compiles `.ts` files. The build script automatically copies `.mdx` template files to `build/templates/`. If you modify templates, rebuild to pick up changes.

---

## Companion Tools

Super Subagents agent templates reference companion MCP servers and skills that dramatically improve agent output quality. The MCP servers provide tools the agents call during execution; the skills inject domain-specific patterns and methodology into agent prompts.

### One-line ecosystem install

```bash
# Install all companion MCP servers + skills + hooks in one shot:
npx super-agents-install-ecosystem

# Or from the repo:
pnpm install-ecosystem
```

This installs all 5 companion MCP servers into your Claude Code config, all 3 required skills, and the PostToolUse notification hook. Run with `--check` to see current status without modifying anything, or `--uninstall` to remove everything.

### MCP Servers

These MCP servers are used by the agent templates. Install them individually or use the ecosystem installer above.

| Server | npm Package | Used By | Purpose |
|---|---|---|---|
| **super-subagents** | [`mcp-supersubagents`](https://www.npmjs.com/package/mcp-supersubagents) | — | This server itself |
| **crash-think-tool** | [`crash-mcp`](https://www.npmjs.com/package/crash-mcp) | All templates | Structured reasoning steps — agents think before and after every action |
| **morph** | [`@morphllm/morphmcp`](https://www.npmjs.com/package/@morphllm/morphmcp) | All templates | Fast code editing (`edit_file`) + codebase search (`warpgrep_codebase_search`) |
| **skills-as-context** | [`mcp-skills-as-context`](https://www.npmjs.com/package/mcp-skills-as-context) | Coder, Planner, Tester, Researcher | Dynamic skill discovery from [skills.sh](https://skills.sh) (`search-skills`, `get-skill-details`) |
| **research-powerpack** | [`mcp-researchpowerpack`](https://www.npmjs.com/package/mcp-researchpowerpack) | Researcher | Web search, Reddit mining, deep research, URL scraping |
| **ask-questions** | [`mcp-vibepowerpack`](https://www.npmjs.com/package/mcp-vibepowerpack) | All templates | Interactive choice popups for user decisions |

<details>
<summary><strong>Manual MCP server install commands</strong></summary>

```bash
# crash-think-tool — structured reasoning (no API key needed)
claude mcp add crash-think-tool -- npx -y crash-mcp@latest

# morph — code editing + warpgrep (requires Morph API key from https://morphllm.com)
claude mcp add morph \
  -e MORPH_API_KEY=your-morph-api-key \
  -e ENABLED_TOOLS=warpgrep_codebase_search,warpgrep_github_search \
  -- npx -y @morphllm/morphmcp@latest

# skills-as-context — skill discovery (no API key needed)
claude mcp add skills-as-context -- npx -y mcp-skills-as-context@latest

# research-powerpack — web + Reddit research (requires API keys)
claude mcp add research-powerpack \
  -e SERPER_API_KEY=your-serper-key \
  -e OPENROUTER_API_KEY=your-openrouter-key \
  -- npx -y mcp-researchpowerpack@latest

# ask-questions — interactive user questions
claude mcp add ask-questions -- npx -y mcp-vibepowerpack@latest
```

See each package's README for full configuration options and optional API keys.

</details>

### Skills

Agent templates auto-load skills from [skills.sh](https://skills.sh) to inject domain expertise. Three skills are directly referenced by name:

| Skill | Template | Install Command | GitHub |
|---|---|---|---|
| **planning** | `super-planner` | `npx skills add yigitkonur/skills-by-yigitkonur/skills/planning` | [skills/planning](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/planning) |
| **playwright-cli** | `super-tester` | `npx skills add yigitkonur/skills-by-yigitkonur/skills/playwright-cli` | [skills/playwright-cli](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/playwright-cli) |
| **research-powerpack** | `super-researcher` | `npx skills add yigitkonur/skills-by-yigitkonur/skills/research-powerpack` | [skills/research-powerpack](https://github.com/yigitkonur/skills-by-yigitkonur/tree/main/skills/research-powerpack) |

Additionally, the **coder** template dynamically discovers skills at runtime via `search-skills` based on the detected tech stack (e.g., `"nextjs app router patterns"`, `"rust async tokio patterns"`). The full skill catalog is at [`yigitkonur/skills-by-yigitkonur`](https://github.com/yigitkonur/skills-by-yigitkonur) (14 skills available).

<details>
<summary><strong>Manual skill install commands</strong></summary>

```bash
# Install all three required skills:
npx skills add yigitkonur/skills-by-yigitkonur/skills/planning
npx skills add yigitkonur/skills-by-yigitkonur/skills/playwright-cli
npx skills add yigitkonur/skills-by-yigitkonur/skills/research-powerpack

# Optional — install ALL available skills from the catalog:
npx skills add yigitkonur/skills-by-yigitkonur/skills/copilot-review-init
npx skills add yigitkonur/skills-by-yigitkonur/skills/design-soul-saas
npx skills add yigitkonur/skills-by-yigitkonur/skills/devin-review-init
npx skills add yigitkonur/skills-by-yigitkonur/skills/greptile-config
npx skills add yigitkonur/skills-by-yigitkonur/skills/mcp-apps-builder
npx skills add yigitkonur/skills-by-yigitkonur/skills/mcp-cli
npx skills add yigitkonur/skills-by-yigitkonur/skills/mcp-server-tester
npx skills add yigitkonur/skills-by-yigitkonur/skills/mcp-use-code-review
npx skills add yigitkonur/skills-by-yigitkonur/skills/snapshot-to-nextjs
npx skills add yigitkonur/skills-by-yigitkonur/skills/supastarter
npx skills add yigitkonur/skills-by-yigitkonur/skills/tauri-devtools
```

</details>

---

## Troubleshooting

<details>
<summary><strong>Rate limits / 429 errors</strong></summary>

- Configure multiple PAT tokens via `GITHUB_PAT_TOKENS` for automatic rotation.
- With a single token, tasks enter exponential backoff (5m to 2h, max 6 retries).
- Check account status: read the `system:///status` MCP resource.
- Failed tokens enter a 60-second cooldown before reuse.

</details>

<details>
<summary><strong>Token configuration not working</strong></summary>

- Tokens are loaded in priority order: `GITHUB_PAT_TOKENS` > `GITHUB_PAT_TOKEN_1..N` > `GH_PAT_TOKEN` > `GITHUB_TOKEN` / `GH_TOKEN`.
- Verify tokens have Copilot access. A PAT without Copilot permissions will fail silently.
- Check the server stderr output for `[account-manager] Initialized with N account(s)`.
- Up to 100 tokens are supported.

</details>

<details>
<summary><strong>Task persistence / recovery</strong></summary>

- Tasks persist to `~/.super-agents/{md5(cwd)}.json` and survive server restarts.
- Rate-limited tasks auto-retry when the server reconnects.
- Live output files at `{cwd}/.super-agents/{task-id}.output` persist for post-hoc review.
- Use `cancel-agent` with `task_id: "all"`, `clear: true`, `confirm: true` to clear all tasks and delete the persistence file.

</details>

<details>
<summary><strong>Agent produces poor results</strong></summary>

- Use the specialized launch tools (`launch-super-coder`, `launch-super-planner`, `launch-super-tester`, `launch-super-researcher`). Each enforces structured briefs and produces dramatically better results.
- Agents run with NO shared memory -- your prompt is their ONLY context. Include all necessary file paths, background, and success criteria.
- Attach context files (`.md`) with detailed plans or specifications.
- For `launch-super-coder`, provide a minimum of 1,000 characters with objective, files, success criteria, constraints, and patterns.

</details>

<details>
<summary><strong>Shutdown / broken pipe issues</strong></summary>

- The server performs a graceful shutdown on SIGINT/SIGTERM: it aborts all fallback sessions, cleans up SDK bindings, kills tracked processes, and closes output file handles.
- If the MCP transport breaks (broken pipe), the server waits up to 15 seconds (configurable via `BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS`) for cleanup before force-exiting.
- On `process.exit`, all tracked child processes are force-killed synchronously to prevent orphaned sessions.

</details>

---

<p align="center">
  <strong>MIT License</strong><br>
  <a href="https://github.com/yigitkonur">Yigit Konur</a>
</p>
