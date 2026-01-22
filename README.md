# Super Agents MCP Server

An MCP server that spawns GitHub Copilot CLI agents as background tasks. Designed for AI-to-AI orchestration with human-readable task IDs, automatic workspace detection, and intelligent polling controls.

## Features

- **Human-Readable Task IDs** — `brave-tiger-42` instead of `a1b2c3d4e5f6`
- **Case-Insensitive Lookups** — `BRAVE-TIGER-42` finds `brave-tiger-42`
- **Batch Status Checks** — Check multiple tasks in one call
- **Auto-Detect Workspace** — Uses client's workspace root as CWD
- **Exponential Backoff Hints** — Prevents excessive polling (30s → 60s → 120s → 180s)
- **Task Templates** — Optimized prompts for coding, planning, research, testing

## Quick Start

```bash
npm install && npm run build
```

Add to your MCP config:

```json
{
  "mcpServers": {
    "super-agents": {
      "command": "node",
      "args": ["/path/to/copilot-agents/build/index.js"]
    }
  }
}
```

## Tools

### `spawn_task`

Execute a task using GitHub Copilot CLI agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | ✅ | What the agent should do |
| `task_type` | enum | ❌ | `super-coder` \| `super-planner` \| `super-researcher` \| `super-tester` |
| `model` | enum | ❌ | `claude-sonnet-4.5` (default) \| `claude-opus-4.5` \| `claude-haiku-4.5` |
| `cwd` | string | ❌ | Working directory (auto-detected from client) |
| `timeout` | number | ❌ | Max execution time in ms (default: 600000 = 10 min) |
| `autonomous` | boolean | ❌ | Run without user prompts (default: true) |

**Response:**
```json
{
  "task_id": "brave-tiger-42",
  "next_action": "get_status",
  "next_action_args": {"task_id": "brave-tiger-42"}
}
```

### `get_status`

Check task status. Supports single ID or array of IDs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string \| string[] | ✅ | Task ID(s) to check |

**Single task response:**
```json
{
  "task_id": "brave-tiger-42",
  "status": "running",
  "session_id": "abc123",
  "retry_after_seconds": 60,
  "retry_command": "sleep 60"
}
```

**Batch response:**
```json
{
  "tasks": [
    {"task_id": "brave-tiger-42", "status": "running", "retry_after_seconds": 60, "retry_command": "sleep 60"},
    {"task_id": "calm-falcon-17", "status": "completed", "exit_code": 0},
    {"task_id": "nonexistent-99", "status": "not_found", "error": "Task not found", "suggested_action": "list_tasks"}
  ]
}
```

### `list_tasks`

List all spawned tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | enum | ❌ | Filter: `pending` \| `running` \| `completed` \| `failed` \| `cancelled` |

**Response:**
```json
{
  "count": 2,
  "tasks": [
    {"task_id": "brave-tiger-42", "status": "running"},
    {"task_id": "calm-falcon-17", "status": "completed"}
  ],
  "next_action": "get_status",
  "next_action_hint": "Use get_status with task_id array to check multiple tasks at once"
}
```

### `resume_task`

Resume a previously interrupted session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | ✅ | Session ID from get_status response |
| `cwd` | string | ❌ | Working directory (auto-detected) |
| `timeout` | number | ❌ | Max execution time (default: 10 min) |

**Response:**
```json
{
  "task_id": "swift-owl-88",
  "resumed_session": "abc123",
  "next_action": "get_status",
  "next_action_args": {"task_id": "swift-owl-88"}
}
```

### `clear_tasks`

Clear all persisted tasks for the current workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `confirm` | boolean | ✅ | Must be `true` to confirm deletion (safety measure) |

**Response:**
```json
{
  "success": true,
  "cleared_tasks": 5,
  "workspace": "/Users/alice/project",
  "workspace_hash": "a1b2c3d4e5f6...",
  "storage_path": "~/.super-agents/a1b2c3d4e5f6....json",
  "message": "Cleared 5 tasks for workspace"
}
```

**⚠️ CAUTION:** This permanently deletes all task history for the current workspace.

### `retry_task`

Manually trigger immediate retry of a rate-limited task without waiting for the scheduled retry time.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The rate-limited task ID to retry |

**Example Response:**
```json
{
  "success": true,
  "original_task_id": "brave-tiger-42",
  "new_task_id": "clever-fox-99",
  "retry_count": 2,
  "message": "Retry triggered. New task clever-fox-99 created.",
  "next_action": "get_status",
  "next_action_args": { "task_id": "clever-fox-99" }
}
```

**Requirements:**
- Task must be in `rate_limited` status
- Task must not have exceeded max retries (6)

### `cancel_task`

Cancel a running or pending task by killing its process.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The task ID to cancel |

**Example Response:**
```json
{
  "success": true,
  "task_id": "brave-tiger-42",
  "previous_status": "running",
  "new_status": "cancelled",
  "message": "Task brave-tiger-42 cancelled successfully",
  "had_process": true
}
```

**Requirements:**
- Task must be in `running` or `pending` status
- Sends SIGTERM to kill the process

## Task Dependencies

Tasks can optionally depend on other tasks. A dependent task waits until all its dependencies complete successfully before running.

**Usage:**
```json
{
  "prompt": "Run integration tests",
  "depends_on": ["brave-tiger-42", "clever-fox-99"]
}
```

**Behavior:**
- Task starts in `waiting` status if dependencies are not yet completed
- Automatically starts when ALL dependencies complete successfully
- If any dependency fails/cancels → task stays `waiting` (won't auto-run)
- No dependencies or all deps already completed → starts immediately

**Validation at creation:**
- All dependency task IDs must exist → error if not found
- Circular dependencies detected and rejected (A→B→A)

**Status response for waiting tasks:**
```json
{
  "task_id": "happy-panda-88",
  "status": "waiting",
  "dependency_info": {
    "depends_on": ["brave-tiger-42", "clever-fox-99"],
    "satisfied": false,
    "pending": ["clever-fox-99"],
    "failed": [],
    "missing": []
  }
}
```

**Edge cases:**
- Dependency deleted before run → task stays `waiting` (shows in `missing`)
- Dependency fails → task stays `waiting` forever (shows in `failed`)
- User can cancel waiting tasks manually

## Rate Limit Auto-Retry

Tasks that fail due to rate limiting are automatically detected and scheduled for retry.

**Detection patterns:**
- "rate limit" / "too many requests"
- "try again in X hours/minutes"
- "exceeded quota" / "throttl"

**Retry behavior:**
- Rate-limited tasks are marked as `rate_limited` (not `failed`)
- On server reconnect, rate-limited tasks are automatically retried
- Uses exponential backoff: 5min → 10min → 20min → 40min → 1hr → 2hr
- Max 6 retry attempts before marking as permanently `failed`

**Status response for rate-limited tasks:**
```json
{
  "task_id": "brave-tiger-42",
  "status": "rate_limited",
  "error": "Sorry, you've hit a rate limit...",
  "retry_info": {
    "reason": "Rate limit exceeded",
    "retry_count": 2,
    "max_retries": 6,
    "next_retry_time": "2024-01-22T17:00:00.000Z",
    "will_auto_retry": true
  }
}
```

**How it works:**
1. Task fails with rate-limit error → marked as `rate_limited` with retry schedule
2. Server connection closes (normal MCP lifecycle)
3. Server reconnects → loads persisted tasks
4. Rate-limited tasks past their `next_retry_time` are automatically re-spawned
5. Repeat until success or max retries exceeded

## Task Templates

| Template | Use Case |
|----------|----------|
| `super-coder` | Implementation — writing code, fixing bugs, refactoring |
| `super-planner` | Architecture — design decisions, breaking down complex work |
| `super-researcher` | Investigation — codebase exploration, understanding systems |
| `super-tester` | Testing — writing tests, QA verification |

## Polling Behavior

The server tracks how many times you've checked each task and provides exponential backoff hints:

| Check # | Wait Time | retry_command |
|---------|-----------|---------------|
| 1st | 30 seconds | `sleep 30` |
| 2nd | 60 seconds | `sleep 60` |
| 3rd | 120 seconds | `sleep 120` |
| 4th+ | 180 seconds | `sleep 180` |

**For agents:** Execute the `retry_command` value before polling again:
```bash
# Example workflow
spawn_task → get_status → extract retry_command → run_command(retry_command) → get_status again
```

## CWD Auto-Detection

The server automatically detects the client's workspace:

1. On connection, server requests `roots/list` from client
2. First root's URI is converted to filesystem path
3. All spawned tasks use this as default CWD

**Fallback chain:** Explicit `cwd` param → Client's first root → Server's `process.cwd()`

## Status Flow

```
spawn_task() → pending → running → completed | failed | cancelled
```

## Task Persistence

Tasks are automatically persisted to disk and survive server restarts.

**Storage location:** `~/.super-agents/{md5(cwd)}.json`

Each workspace gets its own isolated task history based on the MD5 hash of the working directory path. This allows multiple users and workspaces to use the same MCP server without conflicts.

**Behavior:**
- Tasks are saved after every state change (debounced to reduce disk I/O)
- On server restart, previously running tasks are marked as `failed` with error `"Server restarted"`
- Completed tasks expire after 1 hour (configurable via `TASK_TTL_MS`)
- Corrupted storage files are handled gracefully (starts fresh with empty task list)

**Atomic writes:** Uses temp file + rename pattern to prevent corruption from concurrent access or crashes.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI binary |

## CLI Testing

```bash
# List all tools
npx @modelcontextprotocol/inspector --cli node build/index.js --method tools/list

# Spawn a task
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name spawn_task \
  --tool-arg 'prompt=Create a hello world script'

# Check status (case-insensitive)
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name get_status \
  --tool-arg 'task_id=BRAVE-TIGER-42'

# Use a template
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name spawn_task \
  --tool-arg 'prompt=Investigate the authentication flow' \
  --tool-arg 'task_type=super-researcher'
```

## License

MIT
