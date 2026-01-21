# Copilot MCP Server - Installation & Usage Guide

## Quick Start

### 1. Install Dependencies
```bash
cd /Users/yigitkonur/dev/my-mcp-servers/copilot-agents
npm install
```

### 2. Build
```bash
npm run build
```

### 3. Verify Installation
```bash
# Check build artifacts
ls build/index.js

# Check Copilot CLI is available
which copilot
# Should output: /opt/homebrew/bin/copilot
```

## Configuration

### MCP Server Setup (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "copilot-agents": {
      "command": "node",
      "args": ["/Users/yigitkonur/dev/my-mcp-servers/copilot-agents/build/index.js"]
    }
  }
}
```

### Environment Variables (Optional)

```bash
export COPILOT_PATH="/custom/path/to/copilot"  # Default: /opt/homebrew/bin/copilot
```

## Usage Examples

### 1. Spawn a Simple Task

```bash
npx @modelcontextprotocol/inspector \
  --cli node build/index.js \
  --method tools/call \
  --tool-name spawn_task \
  --tool-arg 'prompt=Create a hello.txt file'
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"task_id\":\"abc123xyz\"}"
    }
  ]
}
```

### 2. Check Task Status

```bash
npx @modelcontextprotocol/inspector \
  --cli node build/index.js \
  --method tools/call \
  --tool-name get_status \
  --tool-arg 'task_id=abc123xyz'
```

**Response:**
```json
{
  "task_id": "abc123xyz",
  "status": "completed",
  "output": ["Creating file...", "Done!"],
  "exit_code": 0,
  "session_id": "session_xyz"
}
```

### 3. Use Templates

```bash
# Researcher template
--tool-arg 'prompt=Research best React practices' \
--tool-arg 'task_type=researcher'

# Architect template
--tool-arg 'prompt=Design a microservices architecture' \
--tool-arg 'task_type=architect'

# Bug researcher
--tool-arg 'prompt=Debug the login error' \
--tool-arg 'task_type=bug-researcher'
```

### 4. Custom Model

```bash
# Use fastest model (Haiku)
--tool-arg 'prompt=Quick calculation' \
--tool-arg 'model=claude-haiku-4.5'

# Use most capable model (Opus)
--tool-arg 'prompt=Complex analysis task' \
--tool-arg 'model=claude-opus-4.5'
```

### 5. Advanced Options

```bash
# Custom working directory
--tool-arg 'cwd=/tmp' \

# Custom timeout (10 seconds)
--tool-arg 'timeout=10000' \

# Allow user prompts (non-autonomous)
--tool-arg 'autonomous=false'
```

### 6. List All Tasks

```bash
npx @modelcontextprotocol/inspector \
  --cli node build/index.js \
  --method tools/call \
  --tool-name list_tasks \
  --tool-arg 'status=running'  # Optional filter
```

### 7. Resume Session

```bash
npx @modelcontextprotocol/inspector \
  --cli node build/index.js \
  --method tools/call \
  --tool-name resume_task \
  --tool-arg 'session_id=session_xyz'
```

## Tool Reference

### spawn_task

**Parameters:**
- `prompt` (required): Task description
- `task_type` (optional): executor | researcher | codebase-researcher | bug-researcher | architect | planner | turkish
- `model` (optional): claude-sonnet-4.5 | claude-opus-4.5 | claude-haiku-4.5
- `cwd` (optional): Working directory path
- `timeout` (optional): Timeout in milliseconds (default: 300000)
- `autonomous` (optional): No user prompts (default: true)

**Returns:** `{ task_id: string }`

### get_status

**Parameters:**
- `task_id` (required): Task identifier

**Returns:**
```json
{
  "task_id": "string",
  "status": "pending|running|completed|failed|cancelled",
  "output": ["line1", "line2"],
  "exit_code": 0,
  "session_id": "string",
  "error": "string (if failed)"
}
```

### list_tasks

**Parameters:**
- `status` (optional): Filter by status

**Returns:**
```json
{
  "count": 3,
  "tasks": [
    { "task_id": "...", "status": "..." }
  ]
}
```

### resume_task

**Parameters:**
- `session_id` (required): Session to resume
- `cwd` (optional): Working directory
- `timeout` (optional): Timeout in ms
- `autonomous` (optional): Boolean

**Returns:** `{ task_id: string, resumed_session: string }`

## Troubleshooting

### Issue: "Copilot CLI not found"

```bash
# Install Copilot CLI first
brew install gh
gh copilot install

# Or set custom path
export COPILOT_PATH="/path/to/copilot"
```

### Issue: "Task not found"

**Cause:** Each inspector call spawns a new server instance.

**Solution:** Use persistent server connection (see examples in TEST_RESULTS.md)

### Issue: "No output captured"

**Cause:** Copilot CLI takes time to process and execute commands.

**Solution:** Wait longer before checking status (5-10+ seconds for complex tasks)

### Issue: "Task timeout"

**Cause:** Default timeout is 5 minutes.

**Solution:** Increase timeout for long-running tasks:
```bash
--tool-arg 'timeout=600000'  # 10 minutes
```

## Best Practices

1. **Use appropriate templates** - Helps guide the AI for specific task types
2. **Set reasonable timeouts** - Complex tasks need more time
3. **Check status periodically** - Don't poll too frequently
4. **Use Haiku for simple tasks** - Faster and cheaper
5. **Use autonomous mode** - For non-interactive automation
6. **Specify working directory** - When tasks need specific context

## Performance Tips

- **Concurrent tasks**: Server handles 100+ tasks simultaneously
- **Auto-cleanup**: Completed tasks cleaned after 1 hour
- **Memory efficient**: Buffers last 2000 output lines per task
- **Fast spawning**: Tasks spawn in <100ms

## Development

```bash
# Watch mode for development
npm run dev

# Clean build
npm run clean && npm run build

# Test manually
node build/index.js
# Then send JSON-RPC requests to stdin
```

## Support

For issues or questions:
1. Check TEST_RESULTS.md for validated behavior
2. Review this guide for usage examples
3. Check Copilot CLI documentation: `gh copilot --help`

---

**Status:** ✅ Production Ready  
**Version:** 1.0.0  
**Last Updated:** 2026-01-21
