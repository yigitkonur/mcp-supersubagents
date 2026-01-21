# Copilot MCP Server

An MCP (Model Context Protocol) server that enables AI assistants to spawn and manage GitHub Copilot CLI tasks programmatically.

## Features

- **Spawn Tasks**: Start Copilot CLI tasks with custom prompts and model selection
- **Track Status**: Poll task status and retrieve output in real-time
- **Cancel Tasks**: Gracefully terminate running tasks
- **List Tasks**: View all active and completed tasks
- **Model Selection**: 14 AI models with tier-based filtering (fast/standard/premium)
- **Resume Sessions**: Continue interrupted Copilot sessions
- **Autonomous Mode**: Run tasks without user interaction prompts
- **Error Categorization**: Detect auth, timeout, and rate limit errors

## Requirements

- Node.js >= 18.0.0
- GitHub Copilot CLI installed at `/opt/homebrew/bin/copilot`
- Valid GitHub Copilot subscription

## Installation

```bash
npm install
npm run build
```

## Usage

### As MCP Server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "copilot-agents": {
      "command": "node",
      "args": ["/path/to/copilot-agents/build/index.js"]
    }
  }
}
```

### Testing with MCP Inspector

```bash
# List available tools
npx @modelcontextprotocol/inspector --cli node build/index.js --method tools/list

# Spawn a task
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call \
  --tool-name spawn_copilot_task \
  --tool-arg 'prompt=What is 2+2?'

# Check status (replace TASK_ID)
npx @modelcontextprotocol/inspector --cli node build/index.js \
  --method tools/call \
  --tool-name get_task_status \
  --tool-arg 'taskId=TASK_ID'
```

## Tools (6 total)

### `spawn_copilot_task`

Spawn a new Copilot CLI task with model selection.

**Parameters:**
- `prompt` (required): The task prompt
- `timeout`: Timeout in ms (default: 300000 = 5 min, max: 1 hour)
- `cwd`: Working directory for the task
- `model`: AI model (see `get_available_models` for options)
- `silent`: Output only response without stats (default: true)
- `autonomous`: Run without user interaction prompts (default: false)

**Returns:** `{ taskId, message }`

### `get_task_status`

Get status and output of a task.

**Parameters:**
- `taskId` (required): The task ID from spawn_copilot_task

**Returns:** `{ taskId, status, output, exitCode, sessionId, errorType, ... }`

### `cancel_task`

Cancel a running task.

**Parameters:**
- `taskId` (required): The task ID to cancel

**Returns:** `{ success, message }`

### `list_tasks`

List all tracked tasks.

**Parameters:**
- `status` (optional): Filter by status (`pending`, `running`, `completed`, `failed`, `cancelled`)

**Returns:** `{ count, tasks: [...] }`

### `get_available_models`

Get list of all available AI models with descriptions.

**Parameters:**
- `tier` (optional): Filter by tier (`fast`, `standard`, `premium`, `all`)

**Returns:** `{ models: [...], recommended, tiers }`

**Available Models:**
| Tier | Models |
|------|--------|
| Fast | `gpt-4.1`, `claude-haiku-4.5`, `gpt-5-mini`, `gpt-5.1-codex-mini` |
| Standard | `claude-sonnet-4` ⭐, `claude-sonnet-4.5`, `gpt-5.2-codex`, `gpt-5`, `gemini-3-pro-preview` |
| Premium | `claude-opus-4.5` |

### `resume_copilot_task`

Resume a previous Copilot session.

**Parameters:**
- `sessionId` (required): Session ID from previous task
- `timeout`: Timeout in ms
- `cwd`: Working directory
- `autonomous`: Run without user prompts

**Returns:** `{ taskId, resumedSessionId, message }`

## Task Status Flow

```
PENDING → RUNNING → COMPLETED
                 ↘ FAILED
                 ↘ CANCELLED
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `COPILOT_PATH` | Path to Copilot CLI binary | `/opt/homebrew/bin/copilot` |

## Security

- Input sanitization with regex whitelist
- No shell injection (uses Execa with args array)
- Zod validation for all inputs
- Path validation for cwd parameter
- Model validation against known list
- Output memory limits (max 2000 lines)
- Error categorization (auth, timeout, rate limit)

## Development

```bash
# Development mode with watch
npm run dev

# Build
npm run build

# Run tests
node test-flow.mjs
node test-comprehensive.mjs
```

## License

MIT
