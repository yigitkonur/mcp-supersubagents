# Super Subagents Architecture

This document describes the architecture of the Super Subagents MCP server, which spawns and manages GitHub Copilot CLI agents as background tasks.

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MCP Client                                      │
│                    (Claude Desktop, Windsurf, etc.)                         │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ MCP Protocol (stdio)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MCP Server Layer                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        src/index.ts                                  │   │
│  │  - Server initialization & MCP protocol handlers                    │   │
│  │  - Tool registration (spawn_task, get_status, list_tasks, etc.)    │   │
│  │  - Resource & subscription handlers                                 │   │
│  │  - Progress & notification wiring                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Service Layer                                       │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │
│  │   Task Manager    │  │  Process Spawner  │  │    Retry Queue        │   │
│  │                   │  │                   │  │                       │   │
│  │ - State machine   │  │ - Copilot CLI     │  │ - Rate limit detect   │   │
│  │ - Dependencies    │  │ - Claude CLI      │  │ - Exponential backoff │   │
│  │ - Lifecycle mgmt  │  │ - Timeout mgmt    │  │ - Auto-retry          │   │
│  └───────────────────┘  └───────────────────┘  └───────────────────────┘   │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────────┐   │
│  │  Task Persistence │  │  Copilot Switch   │  │  Client Context       │   │
│  │                   │  │                   │  │                       │   │
│  │ - Atomic writes   │  │ - Account rotate  │  │ - Workspace roots     │   │
│  │ - Crash recovery  │  │ - Lock management │  │ - Default CWD         │   │
│  └───────────────────┘  └───────────────────┘  └───────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         External Processes                                   │
│  ┌───────────────────────────────┐  ┌───────────────────────────────────┐  │
│  │       Copilot CLI             │  │        Claude CLI (fallback)      │  │
│  │  /opt/homebrew/bin/copilot    │  │            claude                 │  │
│  └───────────────────────────────┘  └───────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## MCP Connection Architecture

### Protocol Implementation

The server uses the **Model Context Protocol (MCP)** SDK to communicate with AI clients via **stdio transport**.

```typescript
// src/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'copilot-agent', version: '1.0.0' },
  {
    capabilities: {
      tools: {},                    // Tool calling
      tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      resources: { subscribe: true, listChanged: true },
    },
  }
);

// Connection via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
```

### MCP Capabilities

| Capability | Implementation |
|------------|----------------|
| **Tools** | 11 tools for task management (`spawn_task`, `batch_spawn`, `get_status`, etc.) |
| **Tasks** | Native MCP task primitive support with status mapping |
| **Resources** | Tasks exposed as subscribable resources (`task:///{task_id}`) |
| **Progress** | Real-time progress notifications via `notifications/progress` |

### Request Handlers

```
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Request Handlers                          │
├─────────────────────────────────────────────────────────────────┤
│  ListToolsRequestSchema    → Returns tool definitions            │
│  CallToolRequestSchema     → Routes to tool handlers             │
│  GetTaskRequestSchema      → Returns MCP Task object             │
│  ListTasksRequestSchema    → Paginated task list                 │
│  CancelTaskRequestSchema   → Cancels running task                │
│  ListResourcesRequestSchema → Tasks as resources                 │
│  ReadResourceRequestSchema  → Task details as JSON               │
│  SubscribeRequestSchema     → Subscribe to task updates          │
│  UnsubscribeRequestSchema   → Unsubscribe from updates           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Copilot Agent Management

### Task Lifecycle State Machine

```
                    ┌──────────────────────────────────────────────────┐
                    │                                                   │
                    ▼                                                   │
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌───────────┐            │
│ PENDING │───▶│ WAITING │───▶│ RUNNING │───▶│ COMPLETED │            │
└─────────┘    └─────────┘    └─────────┘    └───────────┘            │
     │              │              │                                    │
     │              │              ├───────────▶ ┌──────────┐          │
     │              │              │             │  FAILED  │          │
     │              │              │             └──────────┘          │
     │              │              │                                    │
     │              │              ├───────────▶ ┌───────────┐         │
     │              │              │             │ CANCELLED │         │
     │              │              │             └───────────┘         │
     │              │              │                                    │
     │              │              ├───────────▶ ┌───────────┐         │
     │              │              │             │ TIMED_OUT │         │
     │              │              │             └───────────┘         │
     │              │              │                                    │
     │              │              └───────────▶ ┌──────────────┐      │
     │              │                            │ RATE_LIMITED │──────┘
     │              │                            └──────────────┘
     │              │                                  │
     └──────────────┴──────────────────────────────────┘
                         (auto-retry)
```

### Status Descriptions

| Status | Description |
|--------|-------------|
| `pending` | Task created, awaiting execution slot |
| `waiting` | Blocked on dependency tasks |
| `running` | Copilot/Claude CLI process active |
| `completed` | Process exited successfully (code 0) |
| `failed` | Process exited with error |
| `cancelled` | User-initiated cancellation |
| `rate_limited` | API rate limit hit, awaiting retry |
| `timed_out` | Exceeded configured timeout |

### Process Spawning Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                        spawn_task / batch_spawn                         │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    spawnCopilotProcess()                                │
│  1. Resolve model (claude-sonnet-4.5, claude-haiku-4.5, opus)         │
│  2. Apply template if task_type specified                              │
│  3. Create task in TaskManager                                         │
│  4. Check dependencies → WAITING if not satisfied                      │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         runProcess()                                    │
│  1. Spawn Copilot CLI via execa                                        │
│  2. Pipe stdout/stderr to task output buffer                           │
│  3. Track PID for health checks                                        │
│  4. Handle exit: success, failure, rate limit, timeout                 │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
        ┌──────────┐       ┌───────────┐       ┌──────────────┐
        │ Success  │       │  Failure  │       │ Rate Limited │
        │ (exit 0) │       │ (exit ≠0) │       │  (detected)  │
        └──────────┘       └───────────┘       └──────┬───────┘
                                                      │
                                                      ▼
                                        ┌─────────────────────────┐
                                        │   handleRateLimit()     │
                                        │  1. Try account switch  │
                                        │  2. Try Claude fallback │
                                        │  3. Exponential backoff │
                                        └─────────────────────────┘
```

### Copilot CLI Arguments

```bash
copilot \
  -p "prompt"           # Task prompt
  --allow-all           # Skip permission prompts
  -s                    # Non-interactive (script mode)
  --model <model>       # claude-sonnet-4.5, etc.
  --no-ask-user         # Fully autonomous (if autonomous=true)
```

### Rate Limit Handling Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Rate Limit Detection                                │
│  Patterns: /rate limit/i, /too many requests/i, /throttl/i, etc.       │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Step 1: Copilot Account Switch                              │
│  - Uses ~/bin/copilot-switch script (if available)                      │
│  - Rotates through up to 3 GitHub accounts in 5-minute window           │
│  - File-based locking prevents concurrent switches                       │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ If exhausted/failed
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Step 2: Claude CLI Fallback                                 │
│  - Falls back to `claude` CLI with --dangerously-skip-permissions       │
│  - Uses Sonnet model for balance of speed/capability                    │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ If also rate limited
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Step 3: Exponential Backoff                                 │
│  Delays: 5m → 10m → 20m → 40m → 1h → 2h (max 6 retries)                │
│  - Extract wait time from error message if available                    │
│  - Add random jitter to prevent thundering herd                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Task Manager (`src/services/task-manager.ts`)

**Central state machine** managing all task lifecycle operations.

```typescript
class TaskManager {
  private tasks: Map<string, TaskState>;
  
  // Lifecycle
  createTask(prompt, cwd, model, options): TaskState
  updateTask(id, updates): TaskState | null
  cancelTask(id): { success: boolean; error?: string }
  
  // Dependencies
  validateDependencies(dependsOn, newTaskId?): string | null
  getDependencyStatus(taskId): DependencyInfo | null
  forceStartTask(taskId): Promise<ForceStartResult>
  
  // Rate limiting
  triggerManualRetry(taskId): Promise<RetryResult>
  expediteRateLimitedTasks(baseDelayMs): void
  
  // Callbacks
  onRetry(callback)       // Rate limit auto-retry
  onExecute(callback)     // Dependency satisfaction
  onStatusChange(callback)
  onOutput(callback)
  onTaskCreated(callback)
  onTaskDeleted(callback)
}
```

**Key features:**
- **Dependency resolution**: Checks if all `dependsOn` tasks are `COMPLETED`
- **Circular dependency detection**: Prevents deadlock on creation
- **Health checks**: Periodic process liveness verification (every 5s)
- **Auto-cleanup**: Removes terminal tasks after 1 hour TTL

### 2. Process Spawner (`src/services/process-spawner.ts`)

**Executes CLI processes** and handles output/error streams.

```typescript
async function spawnCopilotProcess(options: SpawnOptions): Promise<string>
async function executeWaitingTask(task: TaskState): Promise<void>
async function runProcess(taskId, args, cwd, timeout): Promise<void>
async function runClaudeFallback(taskId, prompt, cwd, timeout): Promise<FallbackResult>
async function handleRateLimit(taskId, cwd, timeout, exitCode, errorText): Promise<void>
```

**Process monitoring:**
- Real-time stdout/stderr streaming to task output buffer
- Session ID extraction from output (for `resume_task`)
- Timeout enforcement via `execa` timeout option
- Stall detection based on output activity

### 3. Retry Queue (`src/services/retry-queue.ts`)

**Manages rate limit recovery** with intelligent backoff.

```typescript
function isRateLimitError(output: string[], error?: string): boolean
function extractWaitTime(output: string[], error?: string): number | null
function calculateNextRetryTime(retryCount, suggestedWaitMs?): string
function createRetryInfo(task, reason, existingRetryInfo?): RetryInfo
function shouldRetryNow(task: TaskState): boolean
function hasExceededMaxRetries(task: TaskState): boolean
```

### 4. Task Persistence (`src/services/task-persistence.ts`)

**Persists task state** to survive server restarts.

```
~/.super-agents/
├── {md5(cwd)}.json          # Task state per workspace
├── copilot-switch.lock      # Account switch lock file
└── copilot-switch.json      # Account switch state
```

**Recovery behavior:**
- `RUNNING`/`PENDING` tasks → marked `FAILED` with `server_restart` reason
- `RATE_LIMITED` tasks → preserved for auto-retry continuation
- Atomic writes via temp file + rename

### 5. Copilot Switch (`src/services/copilot-switch.ts`)

**Rotates GitHub accounts** on rate limit.

```typescript
function isSwitchAvailable(): boolean
async function trySwitchAccount(): Promise<SwitchResult>
// Result: 'switched' | 'recentSwitch' | 'exhausted' | 'failed' | 'disabled'
```

**Safeguards:**
- File-based exclusive lock (POSIX atomic)
- Stale lock detection (age + PID liveness)
- 5-minute window tracking (max 3 switches)
- 45-second "recent switch" cooldown

---

## Tool Architecture

### Tool Definition Pattern

Each tool in `src/tools/` exports:

```typescript
// Tool definition for MCP registration
export const myTool = {
  name: 'tool_name',
  description: 'What it does',
  inputSchema: { type: 'object', properties: {...}, required: [...] }
};

// Handler function
export async function handleMyTool(args: unknown, ctx?: ToolContext): Promise<MCPResult> {
  const parsed = MyToolSchema.parse(args);  // Zod validation
  // ... implementation
  return mcpText('Response text');
}
```

### Available Tools

| Tool | Purpose |
|------|---------|
| `spawn_task` | Create single task with full configuration |
| `batch_spawn` | Create multiple tasks with dependencies (max 20) |
| `get_status` | Check status of one or more tasks |
| `list_tasks` | List all tasks with optional filtering |
| `resume_task` | Resume interrupted session by session_id |
| `retry_task` | Manually retry a rate-limited task |
| `cancel_task` | Kill running/pending task |
| `recover_task` | Recover timed_out task |
| `force_start` | Start waiting task, bypass dependencies |
| `clear_tasks` | Delete all tasks (requires confirmation) |
| `stream_output` | Get incremental output (experimental) |

---

## Templates System

### Template Application

Templates in `src/templates/*.mdx` provide specialized agent instructions:

```typescript
// src/templates/index.ts
const TASK_TYPES = {
  'super-coder': 'implementation, bug fixes, refactoring',
  'super-planner': 'architecture, design decisions',
  'super-researcher': 'codebase exploration, investigation',
  'super-tester': 'writing tests, QA verification',
};

function applyTemplate(taskType: TaskType, userPrompt: string): string {
  const template = loadTemplate(taskType);  // Cached MDX content
  return template.includes('{{user_prompt}}')
    ? template.replace('{{user_prompt}}', userPrompt)
    : `${template}\n\n---\n\n${userPrompt}`;
}
```

---

## MCP Status Mapping

Internal 8-state model maps to MCP 4-state model:

```typescript
// src/services/task-status-mapper.ts
function mapInternalStatusToMCP(status: TaskStatus): MCPStatus {
  switch (status) {
    case TaskStatus.PENDING:
    case TaskStatus.WAITING:
    case TaskStatus.RUNNING:
    case TaskStatus.RATE_LIMITED:
      return 'working';
    case TaskStatus.COMPLETED:
      return 'completed';
    case TaskStatus.FAILED:
    case TaskStatus.TIMED_OUT:
      return 'failed';
    case TaskStatus.CANCELLED:
      return 'cancelled';
  }
}
```

---

## Notification System

### Event Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      TaskManager Events                                  │
└────────┬──────────────────┬──────────────────┬──────────────────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌────────────────┐  ┌───────────────┐  ┌──────────────────┐
│   onOutput     │  │ onStatusChange │  │ onTaskCreated/   │
│                │  │               │  │ onTaskDeleted    │
└───────┬────────┘  └───────┬───────┘  └────────┬─────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌────────────────┐  ┌───────────────┐  ┌──────────────────┐
│ProgressRegistry│  │ MCP Task      │  │ ResourceList     │
│ .sendProgress() │  │ notification  │  │ Changed          │
└───────┬────────┘  └───────┬───────┘  └────────┬─────────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  MCP Client   │
                    └───────────────┘
```

### Progress Registry

Throttled progress notifications (max 1 per 100ms):

```typescript
class ProgressRegistry {
  register(taskId, progressToken, sendNotification)
  unregister(taskId)
  sendProgress(taskId, message, total?)  // Throttled + batched
}
```

### Resource Subscriptions

Tasks exposed as resources with change notifications:

```typescript
// URI format
taskIdToUri('brave-tiger-42')  // → 'task:///brave-tiger-42'

// Client subscribes
server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptionRegistry.subscribe(request.params.uri);
});

// Output triggers debounced update (max 1/sec per task)
taskManager.onOutput((taskId, line) => {
  if (subscriptionRegistry.isSubscribed(taskIdToUri(taskId))) {
    server.sendResourceUpdated({ uri }).catch(() => {});
  }
});
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Copilot CLI executable |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI for fallback |
| `ENABLE_OPUS` | `false` | Allow opus model |
| `ENABLE_STREAMING` | `false` | Enable `stream_output` tool |
| `MCP_TASK_TIMEOUT_MS` | `1800000` | Default timeout (30 min) |
| `MCP_TASK_TIMEOUT_MIN_MS` | `1000` | Minimum timeout |
| `MCP_TASK_TIMEOUT_MAX_MS` | `3600000` | Maximum timeout (1 hour) |
| `MCP_TASK_STALL_WARN_MS` | `300000` | Stall warning (5 min) |
| `MCP_COPILOT_SWITCH_TIMEOUT_MS` | `120000` | Switch command timeout |

---

## Data Flow Example

### Spawn Task → Completion

```
1. Client calls spawn_task
   ├─ Validate via Zod schema
   ├─ Apply template (if task_type)
   └─ spawnCopilotProcess()

2. TaskManager.createTask()
   ├─ Generate human-readable ID (brave-tiger-42)
   ├─ Check dependencies → PENDING or WAITING
   └─ Persist to disk

3. runProcess()
   ├─ execa(copilot, args, { timeout, cwd })
   ├─ Stream stdout → TaskManager.appendOutput()
   └─ await process completion

4. On exit
   ├─ exit 0 → COMPLETED
   ├─ rate limit → handleRateLimit() → RATE_LIMITED or retry
   └─ error → FAILED

5. Notifications
   ├─ onStatusChange → MCP task notification
   ├─ onOutput → Progress registry (if subscribed)
   └─ Resource updated (if subscribed)

6. Client polls get_status or receives notifications
```

---

## Error Handling

### Graceful Shutdown

```typescript
process.on('SIGINT', () => {
  taskManager.shutdown();  // Kill running processes, persist state
  process.exit(0);
});
```

### Crash Recovery

On startup:
1. Load persisted tasks from `~/.super-agents/{md5(cwd)}.json`
2. Mark orphaned `RUNNING`/`PENDING` as `FAILED` with `server_restart` reason
3. Preserve `RATE_LIMITED` tasks for auto-retry continuation
4. Process waiting tasks whose dependencies are now satisfied

---

## Security Considerations

- **No hardcoded credentials**: API keys via environment or CLI auth
- **Process isolation**: Each task runs as separate process
- **File permissions**: Persistence directory in user home (~/.super-agents/)
- **Lock files**: Atomic creation prevents race conditions
