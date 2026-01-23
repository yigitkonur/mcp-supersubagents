# Super Agents MCP Server

MCP server that spawns GitHub Copilot CLI agents as background tasks with human-readable IDs, dependency chains, and automatic rate-limit retry.

## Quick Start

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
| `force_start` | Start a waiting task, bypassing dependencies. |
| `clear_tasks` | Delete all tasks for workspace. Requires `confirm: true`. |
| `stream_output` | Get incremental output with offset. Efficient for streaming. |

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
`claude-sonnet-4.5` (default), `claude-opus-4.5`, `claude-haiku-4.5`

### Timeout
Default: 10 min (600000ms). Max: 1 hour. Tasks exceeding timeout get `timed_out` status.

### Rate Limit Auto-Retry
Rate-limited tasks auto-retry with exponential backoff (5m → 10m → 20m → 40m → 1h → 2h). Max 6 retries.

### Persistence
Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Survives server restarts.

### Output Streaming
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

## License

MIT
