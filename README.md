# Super Subagents

Run multiple AI agents in parallel from a single MCP client. Spawn autonomous GitHub Copilot sessions as background tasks — each one gets its own workspace, tools, and execution context. Your main session stays unblocked while agents code, plan, research, and test simultaneously.

## Why

AI coding assistants work one task at a time. You ask it to refactor a module, and you wait. Then you ask it to write tests, and you wait again. Then you ask it to update the docs.

Super Subagents changes this. From your MCP client (Claude Code, VS Code, etc.), you spawn tasks that run as independent Copilot SDK sessions in the background:

```
You (main session):  "Spawn three tasks: refactor auth, write API tests, update the migration guide"

→ brave-tiger-42:    Refactoring auth module...          [running]
→ calm-falcon-17:    Writing API integration tests...    [running]
→ swift-panda-88:    Updating migration guide...         [running]

You:                 Continue working on other things — or spawn more tasks.
```

Each agent runs with full tool access (file read/write, terminal, search) in its own isolated session. When it finishes, you get notified. If it hits a rate limit, it rotates to another GitHub account automatically.

## Quick Start

**Option 1: Auto-install**
```bash
npx @automcp/cli install super-subagents --client claude-desktop
```

**Option 2: Manual config**

Add to your MCP client config (e.g., `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "super-agents": {
      "command": "npx",
      "args": ["-y", "super-subagents"],
      "env": {
        "GITHUB_PAT_TOKENS": "ghp_token1,ghp_token2"
      }
    }
  }
}
```

No build step required — `npx` runs the package directly.

## How It Works

Super Subagents is an MCP server. Your MCP client connects to it over stdio and gets 4 tools and a set of resources for monitoring.

**Spawning a task** creates an autonomous Copilot SDK session that runs in the background. The session has full access to the filesystem, terminal, and all tools the Copilot agent normally has. Your prompt is the agent's only context — it can't see your conversation history.

**Monitoring** happens via MCP resources (not polling). Subscribe to `task:///{id}` for real-time updates, or read `task:///all` to see everything at once. Each task also writes a live output file you can `tail -f`.

**Rate limits** are handled automatically. With multiple PAT tokens configured, the server rotates to the next account when one gets rate-limited. If all accounts are exhausted, tasks enter exponential backoff and retry automatically.

## Tools

| Tool | What it does |
|------|-------------|
| `spawn_task` | Create a new autonomous agent task. Returns a `task_id`. |
| `send_message` | Send a follow-up message to a completed/failed task's session. |
| `cancel_task` | Cancel one task, multiple tasks, or all tasks. |
| `answer_question` | Respond when an agent asks a question via `ask_user`. |

## Resources

All status and monitoring is done through MCP resources:

| Resource URI | Content |
|-------------|---------|
| `system:///status` | Account stats, task counts, SDK health |
| `task:///all` | All tasks with status, progress, pending questions |
| `task:///{id}` | Full task details: output, metrics, config |
| `task:///{id}/session` | Execution log: turns, tool calls, durations |

## Agent Templates

Templates wrap your prompt with specialized system instructions. The agent sees the template + your prompt, not your conversation.

| Template | Personality | Best for |
|----------|------------|----------|
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

## Models

| Model | When to use |
|-------|------------|
| `claude-sonnet-4.5` | Default. Best balance of speed and capability. |
| `claude-haiku-4.5` | Simple tasks, quick iterations. |
| `claude-opus-4.5` | Complex reasoning, large refactors. Requires `ENABLE_OPUS=true`. |

## Multi-Account Rotation

Configure multiple GitHub PAT tokens. When one account hits a rate limit (429) or server error (5xx), the server rotates to the next automatically — mid-session, without losing progress.

```bash
# Comma-separated (recommended)
GITHUB_PAT_TOKENS=ghp_token1,ghp_token2,ghp_token3

# Or numbered
GITHUB_PAT_TOKEN_1=ghp_token1
GITHUB_PAT_TOKEN_2=ghp_token2

# Or single token
GITHUB_TOKEN=ghp_token
```

Failed tokens enter a 60-second cooldown before reuse. If all tokens are exhausted, tasks enter exponential backoff (5m, 10m, 20m, 40m, 1h, 2h — max 6 retries).

## Task Dependencies

Tasks can wait for other tasks:

```json
{
  "prompt": "Deploy the service",
  "depends_on": ["build-task-id", "test-task-id"]
}
```

The task stays in `waiting` status until all dependencies complete, then auto-starts. Circular dependencies are detected and rejected.

## Question Handling

When a Copilot agent calls `ask_user`, the task pauses and surfaces the question through MCP notifications and resources.

```json
// Answer by choice number (1-indexed)
{ "task_id": "brave-tiger-42", "answer": "2" }

// Or free-form text
{ "task_id": "brave-tiger-42", "answer": "CUSTOM: Use TypeScript instead" }
```

Pending questions appear in `task:///all` and on the individual task resource. Questions time out after 30 minutes.

## Session Continuation

Send follow-up messages to completed or failed tasks:

```json
// Default: "continue"
{ "task_id": "brave-tiger-42" }

// With a specific message
{ "task_id": "brave-tiger-42", "message": "Now add unit tests for the changes you made" }
```

This creates a new task that resumes the same Copilot session, so the agent retains full context of what it did.

## Live Output Files

Every task writes a live output file at `{cwd}/.super-agents/{task-id}.output`:

```bash
tail -f .super-agents/brave-tiger-42.output    # Follow live
tail -20 .super-agents/brave-tiger-42.output   # Last 20 lines
cat .super-agents/brave-tiger-42.output        # Full output
```

Output files include a header (task ID, start time, working directory), all tool calls with durations, reasoning traces, usage metrics, and a footer (completion time, final status).

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

## Persistence

Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Survives server restarts. Rate-limited tasks auto-retry on reconnect. Output files persist in `{cwd}/.super-agents/` for post-hoc review.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_PAT_TOKENS` | — | Comma-separated PAT tokens for multi-account rotation |
| `GITHUB_PAT_TOKEN_1`..`_N` | — | Numbered PAT tokens |
| `GH_PAT_TOKEN` | — | Fallback PAT token(s), comma-separated |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | Single token fallback |
| `ENABLE_OPUS` | `false` | Allow claude-opus-4.5 model |
| `MCP_TASK_TIMEOUT_MS` | `1800000` | Default task timeout (30 min) |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` | Maximum allowed timeout (1 hour) |
| `MCP_TASK_STALL_WARN_MS` | `300000` | No-output warning threshold (5 min) |

## Example: Parallel Feature Development

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

## License

MIT
