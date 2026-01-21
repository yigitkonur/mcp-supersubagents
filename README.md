# Copilot Agent MCP Server

MCP server for spawning GitHub Copilot CLI subagent tasks.

## Tools (4)

| Tool | Description |
|------|-------------|
| `spawn_task` | Execute a task, returns task_id |
| `get_status` | Poll task status and output |
| `list_tasks` | List all tasks |
| `resume_task` | Resume session by session_id |

## Models (3)

| Model | Description |
|-------|-------------|
| `claude-sonnet-4.5` | Default - best balance |
| `claude-opus-4.5` | Most capable |
| `claude-haiku-4.5` | Fastest |

## Templates (7)

`executor` | `researcher` | `codebase-researcher` | `bug-researcher` | `architect` | `planner` | `turkish`

## Install

```bash
npm install && npm run build
```

## MCP Config

```json
{
  "mcpServers": {
    "copilot": {
      "command": "node",
      "args": ["/path/to/copilot-agents/build/index.js"]
    }
  }
}
```

## Usage

```bash
# List tools
npx @modelcontextprotocol/inspector --cli node build/index.js --method tools/list

# Spawn task
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name spawn_task \
  --tool-arg 'prompt=Create hello.txt with Hello World'

# Get status
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name get_status \
  --tool-arg 'task_id=TASK_ID'

# With template
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call --tool-name spawn_task \
  --tool-arg 'prompt=Research best practices for React' \
  --tool-arg 'task_type=researcher'
```

## API

### `spawn_task`

```json
{
  "prompt": "Task description (required)",
  "task_type": "executor|researcher|...",
  "model": "claude-sonnet-4.5",
  "cwd": "/working/directory",
  "timeout": 300000,
  "autonomous": true
}
```
Returns: `{ task_id }`

### `get_status`

```json
{ "task_id": "abc123" }
```
Returns: `{ task_id, status, session_id, exit_code, output }`

### `list_tasks`

```json
{ "status": "running" }
```
Returns: `{ count, tasks: [{ task_id, status, session_id }] }`

### `resume_task`

```json
{ "session_id": "xyz789", "cwd": "/path" }
```
Returns: `{ task_id, resumed_session }`

## Status Flow

```
pending → running → completed | failed
```

## Env

| Variable | Default |
|----------|---------|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` |

## License

MIT
