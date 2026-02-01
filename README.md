# Super Agents MCP Server

MCP server that spawns GitHub Copilot CLI agents as background tasks with human-readable IDs, dependency chains, and automatic rate-limit retry.

## Quick Start

Install via install-mcp:
```bash
npx install-mcp super-subagents --client claude-desktop
```

Manual build:
```bash
npm install && npm run build
```

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

| Tool | Description |
|------|-------------|
| `spawn_task` | Create a task. Returns `task_id` for tracking. |
| `batch_spawn` | Create multiple tasks with dependency chains (max 20). |
| `get_status` | Check task status. Supports batch checking with array. |
| `list_tasks` | List all tasks. Filter by `status` or `label`. |
| `resume_task` | Resume interrupted session by `session_id`. |
| `retry_task` | Immediately retry a rate-limited task. |
| `cancel_task` | Kill a running/pending task (SIGTERM). |
| `recover_task` | Recover a timed_out task (resume if session is available). |
| `force_start` | Start a waiting task, bypassing dependencies. |
| `clear_tasks` | Delete all tasks for workspace. Requires `confirm: true`. |
| `stream_output` | *(experimental)* Get incremental output with offset. Requires `ENABLE_STREAMING=true`. |

## Task Statuses

`pending` → `waiting` → `running` → `completed` | `failed` | `cancelled` | `rate_limited` | `timed_out`

## Features

### Dependencies
```json
{ "prompt": "Deploy", "depends_on": ["build-task-id", "test-task-id"] }
```
Task waits until all dependencies complete. Use `force_start` to bypass.

### Labels
```json
{ "prompt": "Build API", "labels": ["backend", "urgent"] }
```
Filter with `list_tasks({ "label": "backend" })`.

### Batch Spawn
```json
{
  "tasks": [
    { "id": "build", "prompt": "Build project" },
    { "id": "test", "prompt": "Run tests", "depends_on": ["build"] },
    { "id": "deploy", "prompt": "Deploy", "depends_on": ["test"] }
  ]
}
```
Local `id` fields map to real `task_id` in response.

### Task Templates

| Template | Use Case |
|----------|----------|
| `super-coder` | Implementation, bug fixes, refactoring |
| `super-planner` | Architecture, design decisions |
| `super-researcher` | Codebase exploration, investigation |
| `super-tester` | Writing tests, QA verification |

### Models
`claude-sonnet-4.5` (default), `claude-haiku-4.5`. Opus blocked by default (set `ENABLE_OPUS=true` to allow).

### Timeout
Default: 30 min (1800000ms). Max: 1 hour. Tasks exceeding timeout get `timed_out` status.
Configurable via `MCP_TASK_TIMEOUT_MS`, `MCP_TASK_TIMEOUT_MIN_MS`, and `MCP_TASK_TIMEOUT_MAX_MS`. Prefer the default unless you have a clear reason to override.
Stall warnings are based on `MCP_TASK_STALL_WARN_MS`. Timed out tasks may include a reason and can be recovered via `recover_task` or `resume_task` when a session is available.

### Rate Limit Auto-Retry
Rate-limited tasks auto-retry with exponential backoff (5m → 10m → 20m → 40m → 1h → 2h). Max 6 retries.

### Persistence
Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Survives server restarts.

### Output Streaming (Experimental)
Requires `ENABLE_STREAMING=true`. Disabled by default.
```json
// First call
{ "task_id": "brave-tiger-42", "offset": 0 }
// Response: { "lines": [...], "next_offset": 50, "has_more": true }

// Subsequent calls
{ "task_id": "brave-tiger-42", "offset": 50 }
```
Use `next_offset` from response to get new lines without re-fetching.

### Polling Backoff
Response includes `retry_after_seconds` (30s → 60s → 120s → 180s) to prevent excessive polling.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Copilot CLI path |
| `ENABLE_OPUS` | `false` | Allow opus model (cost control) |
| `ENABLE_STREAMING` | `false` | Enable experimental `stream_output` tool |
| `MCP_TASK_TIMEOUT_MS` | `1800000` | Default task timeout (ms) |
| `MCP_TASK_TIMEOUT_MIN_MS` | `1000` | Minimum allowed task timeout (ms) |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` | Maximum allowed task timeout (ms) |
| `MCP_TASK_STALL_WARN_MS` | `300000` | No-output stall warning threshold (ms) |
| `MCP_COPILOT_SWITCH_TIMEOUT_MS` | `120000` | Timeout for copilot-switch command (ms) |
| `MCP_COPILOT_SWITCH_LOCK_STALE_MS` | `150000` | Stale lock threshold for copilot-switch (ms) |
| `MCP_COPILOT_SWITCH_LOCK_TIMEOUT_MS` | `150000` | Wait timeout for copilot-switch lock (ms) |
| `MCP_COPILOT_SWITCH_LOCK_POLL_MS` | `500` | Lock poll interval for copilot-switch (ms) |

## License

MIT
