# Super Subagents

MCP server for spawning autonomous GitHub Copilot agents as background tasks. Features multi-account rotation, automatic rate limit recovery, and MCP Resources for status tracking.

## Quick Start

**Option 1: Auto-install (recommended)**
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
        "GITHUB_PAT_TOKENS": "ghp_token1,ghp_token2,ghp_token3"
      }
    }
  }
}
```

No build required - `npx` runs the package directly.

## Tools (4)

| Tool | Description |
|------|-------------|
| `spawn_task` | Create autonomous agent task. Returns `task_id`. |
| `send_message` | Send follow-up message to existing session. |
| `cancel_task` | Cancel task(s) or clear all with `task_id: "all"`. |
| `answer_question` | Answer pending question from Copilot's `ask_user`. |

## MCP Resources

Status and task details are accessed via **MCP Resources** (not tools):

| Resource | Description |
|----------|-------------|
| `system:///status` | Account stats, task counts, SDK info |
| `task:///all` | All tasks with status, progress, pending questions |
| `task:///{id}` | Full task details, output, metrics |
| `task:///{id}/session` | Execution log with tool calls |

## Task Statuses

```text
pending → waiting → running → completed | failed | cancelled | rate_limited | timed_out
```

## Features

### Multi-Account Rotation

Configure multiple GitHub PAT tokens for automatic rotation on rate limits (429) or server errors (5xx):

```bash
# Option 1: Comma-separated list
GITHUB_PAT_TOKENS=ghp_token1,ghp_token2,ghp_token3

# Option 2: Numbered variables
GITHUB_PAT_TOKEN_1=ghp_token1
GITHUB_PAT_TOKEN_2=ghp_token2

# Option 3: Single token fallback
GITHUB_TOKEN=ghp_token
```

Rotation happens automatically - no manual intervention needed.

### Task Types (Templates)

| Template | Use Case |
|----------|----------|
| `super-coder` | Implementation, bug fixes, refactoring |
| `super-planner` | Architecture, design decisions |
| `super-researcher` | Codebase exploration, investigation |
| `super-tester` | Writing tests, QA verification |

```json
{ "prompt": "Fix the auth bug", "task_type": "super-coder" }
```

### Models

- **`claude-sonnet-4.5`** - Default. Best balance of speed and capability.
- **`claude-haiku-4.5`** - Fastest. Simple tasks, quick iterations.
- **`claude-opus-4.5`** - Most capable. Requires `ENABLE_OPUS=true`.

### Dependencies

Tasks can wait for other tasks to complete:

```json
{ "prompt": "Deploy", "depends_on": ["build-task-id", "test-task-id"] }
```

### Labels

Group and filter tasks:

```json
{ "prompt": "Build API", "labels": ["backend", "phase-1"] }
```

### Pending Questions

When Copilot asks a question via `ask_user`, the task pauses. Answer with:

```json
// By choice number
{ "task_id": "abc123", "answer": "2" }

// Custom answer
{ "task_id": "abc123", "answer": "CUSTOM: Use TypeScript instead" }
```

Check `task:///all` resource to see tasks with pending questions.

### Session Continuation

Send follow-up messages to completed/failed tasks:

```json
// Resume with default "continue"
{ "task_id": "abc123" }

// Or with custom message
{ "task_id": "abc123", "message": "now add unit tests" }
```

### Rate Limit Auto-Retry

Rate-limited tasks auto-retry with exponential backoff (5m → 10m → 20m → 40m → 1h → 2h). Max 6 retries. With multi-account, rotation happens before retries.

### Live Output Files

Each task creates a live output file for real-time monitoring:

```text
{cwd}/.super-agents/{task-id}.output
```

**Monitor progress without polling:**
```bash
tail -20 .super-agents/brave-tiger-42.output   # Last 20 lines
tail -f .super-agents/brave-tiger-42.output    # Follow live
wc -l .super-agents/brave-tiger-42.output      # Line count
cat .super-agents/brave-tiger-42.output        # Full output
```

Tool responses include the `output_file` path for easy copy-paste.

### Persistence

Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Survives server restarts.
Output files persist in `{cwd}/.super-agents/` for post-hoc review.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_PAT_TOKENS` | - | Comma-separated PAT tokens for multi-account |
| `ENABLE_OPUS` | `false` | Allow claude-opus-4.5 model |
| `MCP_TASK_TIMEOUT_MS` | `1800000` | Default task timeout (30 min) |
| `MCP_TASK_TIMEOUT_MIN_MS` | `1000` | Minimum allowed timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` | Maximum allowed timeout (1 hour) |
| `MCP_TASK_STALL_WARN_MS` | `300000` | No-output warning threshold (5 min) |

## Example Workflow

```
1. spawn_task({ prompt: "...", task_type: "super-coder" })
   → Returns:
     ✅ Task launched
     task_id: brave-tiger-42
     output_file: /path/to/project/.super-agents/brave-tiger-42.output

2. Continue with other work - MCP notifications alert on completion

3. Optional: Check progress anytime
   tail -20 /path/to/project/.super-agents/brave-tiger-42.output

4. If task completes and you want follow-up:
   send_message({ task_id: "brave-tiger-42", message: "now add tests" })

5. If task has pending question:
   answer_question({ task_id: "brave-tiger-42", answer: "1" })
```

## License

MIT
