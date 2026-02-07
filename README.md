<h1 align="center">🤖 Super Subagents 🤖</h1>

<h3 align="center">Stop waiting. Start spawning.</h3>

<p align="center">
  Spawn parallel autonomous Copilot agent sessions from a single MCP client. Each agent gets its own workspace, tools, and execution context. Your main session stays unblocked while agents code, plan, research, and test simultaneously.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-supersubagents"><img src="https://img.shields.io/npm/v/mcp-supersubagents?style=flat-square&color=cb3837&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/node/v/mcp-supersubagents?style=flat-square&color=339933&label=node" alt="node 18+">
  <a href="https://github.com/yigitkonur/mcp-supersubagents/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="platform">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/4_tools-ready_to_use-brightgreen?style=flat-square" alt="4 tools">
  <img src="https://img.shields.io/badge/⚡_parallel--spawn-unlimited_agents-orange?style=flat-square" alt="parallel spawn">
</p>

---

## Quick Navigation

[Get Started](#get-started) &#8226; [Why Super Subagents](#why-super-subagents) &#8226; [Tools](#tool-reference) &#8226; [Templates](#agent-templates) &#8226; [Configuration](#environment-variables) &#8226; [Examples](#recommended-workflows)

---

## The Pitch

AI coding assistants work one task at a time. You ask it to refactor a module, and you wait. Then you ask it to write tests, and you wait again. Then you ask it to update the docs. **Super Subagents multiplies your AI coding bandwidth.** Instead of sequential requests, spawn N agents that work simultaneously -- each with full tool access (file read/write, terminal, search) in its own isolated Copilot SDK session.

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

Each agent runs as an autonomous Copilot SDK session in the background. When it finishes, you get notified via MCP. If it hits a rate limit, it rotates to another GitHub account automatically. Task IDs are human-readable (`brave-tiger-42`, `calm-falcon-17`) so you can track them at a glance.

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

### Option 1: Auto-install (recommended)

```bash
npx @automcp/cli install super-subagents --client claude-desktop
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

> **Note:** You need at least one GitHub PAT token with Copilot access. For rate-limit resilience, configure multiple tokens via `GITHUB_PAT_TOKENS`. See [Multi-Account Rotation](#multi-account-rotation) for details.

---

## Transport Modes

Super Subagents supports two transport modes:

| Mode | Use Case | How to Start |
|------|----------|-------------|
| **STDIO** (default) | Claude Desktop, Cursor, Windsurf | `npx mcp-supersubagents` |
| **HTTP Streamable** | Self-hosted, Docker, LAN sharing | `MCP_TRANSPORT=http npx mcp-supersubagents` |

### Self-Hosted HTTP Streamable

```bash
# Start on default port 3001
MCP_TRANSPORT=http npx mcp-supersubagents

# Custom port
MCP_TRANSPORT=http MCP_PORT=8080 npx mcp-supersubagents
```

```json
{
  "mcpServers": {
    "supersubagents-http": {
      "type": "streamable-http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

---

## Tool Reference

Super Subagents exposes **4 MCP tools** for task orchestration:

<table>
<tr>
<td width="25%" align="center"><strong>🚀 spawn_task</strong><br>Create a new agent</td>
<td width="25%" align="center"><strong>💬 send_message</strong><br>Follow-up on a task</td>
<td width="25%" align="center"><strong>🛑 cancel_task</strong><br>Cancel one or all</td>
<td width="25%" align="center"><strong>❓ answer_question</strong><br>Respond to agent</td>
</tr>
</table>

### `spawn_task`

Create a new autonomous agent task. The agent runs in an isolated session with NO shared memory -- your prompt is its only context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Complete self-contained instructions for the agent |
| `task_type` | string | No | Agent template: `super-coder`, `super-planner`, `super-researcher`, `super-tester`, `super-questioner`, `super-arabic` |
| `context_files` | array | No | Files to read and inject into the prompt. Each item: `{ path, description }` |
| `model` | string | No | Model to use. Default: `claude-sonnet-4.5` |
| `cwd` | string | No | Absolute path to working directory |
| `timeout` | number | No | Max execution time in ms. Default: 1800000 (30 min) |
| `depends_on` | string[] | No | Task IDs that must complete before this starts |
| `labels` | string[] | No | Labels for grouping/filtering (max 10) |

```json
{
  "prompt": "Refactor the auth module to use JWT refresh tokens. Read /src/services/auth.ts for current implementation...",
  "task_type": "super-coder",
  "model": "claude-sonnet-4.5",
  "labels": ["backend", "auth"]
}
```

> **Tip:** For better validation and guided briefs, use the specialized tools: `spawn_coder`, `spawn_planner`, `spawn_tester`, `spawn_researcher`. These enforce structured prompts and produce dramatically better results.

### `send_message`

Send a follow-up message to a completed or failed task's session. Resumes the same Copilot session so the agent retains full context of what it did.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes* | Task ID to send message to |
| `session_id` | string | Yes* | Alternative: session ID directly |
| `message` | string | No | Message to send. Default: `"continue"` |
| `timeout` | number | No | Max execution time in ms |

*Provide either `task_id` or `session_id`.

```json
{ "task_id": "brave-tiger-42", "message": "Now add unit tests for the changes you made" }
```

### `cancel_task`

Cancel one task, multiple tasks, or all tasks. Running/pending tasks are killed (SIGTERM). Completed/failed tasks are removed from memory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string or string[] | Yes | Single ID, array of IDs, or `"all"` |
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

### `answer_question`

Respond when a Copilot agent asks a question via `ask_user`. The task pauses until you answer.

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
| `super-questioner` | Always asks a clarifying question before starting work. | Tasks with ambiguous requirements |
| `super-arabic` | Responds entirely in Arabic. | Arabic-language tasks |

```json
{ "prompt": "Fix the null check in auth.ts line 45", "task_type": "super-coder" }
```

Without a `task_type`, the agent gets your raw prompt with no system instructions.

---

## Models

| Model | When to Use |
|---|---|
| `claude-sonnet-4.5` | **Default.** Best balance of speed and capability. Recommended for most tasks. |
| `claude-haiku-4.5` | Simple, well-defined tasks. Quick iterations. |
| `claude-opus-4.6` | Complex reasoning, large refactors. Always available via `opus` alias. Set `ENABLE_OPUS=true` to show in tool descriptions. |

> **Note:** `super-planner` always uses `claude-opus-4.6` regardless of the `model` parameter -- planning requires maximum reasoning capability.

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

Circular dependencies are detected and rejected at spawn time.

### Example: Chained pipeline

```
spawn_planner → plan-tiger-42         [running]
spawn_coder   → code-falcon-17        [waiting for plan-tiger-42]
spawn_tester  → test-panda-88         [waiting for code-falcon-17]

plan-tiger-42 completes → code-falcon-17 auto-starts
code-falcon-17 completes → test-panda-88 auto-starts
```

---

## Question Handling

When a Copilot agent calls `ask_user`, the task pauses and surfaces the question through MCP notifications and resources. Pending questions appear in `task:///all` and on the individual task resource.

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

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_PAT_TOKENS` | -- | Comma-separated PAT tokens for multi-account rotation |
| `GITHUB_PAT_TOKEN_1`..`_N` | -- | Numbered PAT tokens (alternative to comma-separated) |
| `GH_PAT_TOKEN` | -- | Fallback PAT token(s), comma-separated |
| `GITHUB_TOKEN` / `GH_TOKEN` | -- | Single token fallback |
| `ENABLE_OPUS` | `false` | Show `claude-opus-4.6` in tool descriptions (opus is always usable via alias) |
| `MCP_TASK_TIMEOUT_MS` | `1800000` (30 min) | Default task timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` (1 hr) | Maximum allowed timeout |
| `MCP_TASK_STALL_WARN_MS` | `300000` (5 min) | No-output warning threshold |

---

## Recommended Workflows

### Parallel Feature Development

```
1. spawn_task({
     prompt: "Implement the /api/users endpoint. Read the OpenAPI spec at /docs/api.yaml for the schema...",
     task_type: "super-coder",
     labels: ["backend", "users-feature"]
   })
   → Task: brave-tiger-42

2. spawn_task({
     prompt: "Write E2E tests for the /api/users endpoint using the test patterns in /tests/...",
     task_type: "super-tester",
     depends_on: ["brave-tiger-42"],
     labels: ["testing", "users-feature"]
   })
   → Task: calm-falcon-17 (waiting for brave-tiger-42)

3. spawn_task({
     prompt: "Research best practices for user data pagination. Compare cursor vs offset...",
     task_type: "super-researcher",
     labels: ["research", "users-feature"]
   })
   → Task: swift-panda-88 (starts immediately, runs in parallel with brave-tiger-42)

4. Continue your own work. MCP notifications arrive as tasks complete.

5. brave-tiger-42 completes → calm-falcon-17 auto-starts (dependencies satisfied)

6. Review results:
   - Read resource: task:///all
   - tail -20 .super-agents/brave-tiger-42.output
   - send_message({ task_id: "brave-tiger-42", message: "Add input validation" })
```

### Plan-Code-Test Pipeline

```
1. spawn_planner  → Creates architecture plan with builder-briefing.md
2. spawn_coder    → depends_on planner, uses briefing as context_file
3. spawn_tester   → depends_on coder, uses tester-checklist.md as context_file
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
```

Eight internal states map to four MCP states (`working`, `completed`, `failed`, `cancelled`) for clients that use MCP task primitives.

### Persistence

Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Survives server restarts. Rate-limited tasks auto-retry on reconnect. Output files persist in `{cwd}/.super-agents/` for post-hoc review.

---

## Development

```bash
# Clone
git clone https://github.com/yigitkonur/mcp-supersubagents.git
cd mcp-supersubagents

# Install dependencies
npm install

# Build (TypeScript + copy MDX templates)
npm run build

# Watch mode (auto-reload)
npm run dev

# Run the compiled server
npm start
```

> **Build note:** `tsc` only compiles `.ts` files. The build script automatically copies `.mdx` template files to `build/templates/`. If you modify templates, rebuild to pick up changes.

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
- Use `cancel_task` with `task_id: "all"`, `clear: true`, `confirm: true` to clear all tasks and delete the persistence file.

</details>

<details>
<summary><strong>Agent produces poor results</strong></summary>

- Use the specialized tools (`spawn_coder`, `spawn_planner`, `spawn_tester`, `spawn_researcher`) instead of `spawn_task`. They enforce structured briefs and produce dramatically better results.
- Agents run with NO shared memory -- your prompt is their ONLY context. Include all necessary file paths, background, and success criteria.
- Attach context files (`.md`) with detailed plans or specifications.
- For coding tasks, provide a minimum of 1,000 characters with objective, files, success criteria, constraints, and patterns.

</details>

---

<p align="center">
  <strong>MIT License</strong><br>
  <a href="https://github.com/yigitkonur">Yigit Konur</a>
</p>
