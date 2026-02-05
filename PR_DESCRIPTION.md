# MCP Resources Refactor: Simplified API Surface & Multi-Account Support

## 🎯 Overview

This PR represents a **major architectural refactor** of the MCP server, fundamentally simplifying the API surface by leveraging MCP Resources as the primary interface for task state retrieval. The changes reduce the tool count from 12 to 4 while providing richer, more comprehensive data through resource endpoints.

**Key Metrics:**
- **Tools reduced:** 12 → 4 (67% reduction)
- **Resources added:** 4 comprehensive endpoints
- **Test coverage:** 73 tests passing (54 comprehensive + 19 multi-token)
- **Lines changed:** ~12,500 additions, ~19,200 deletions (net -6,700 lines)

---

## 📋 Table of Contents

1. [Breaking Changes](#breaking-changes)
2. [New Architecture](#new-architecture)
3. [Tools Reference](#tools-reference)
4. [Resources Reference](#resources-reference)
5. [Multi-Account Support](#multi-account-support)
6. [Test Suite](#test-suite)
7. [Migration Guide](#migration-guide)
8. [Files Changed](#files-changed)
9. [Commits](#commits)

---

## ⚠️ Breaking Changes

### Tools Removed (Replaced by Resources)

| Removed Tool | Replacement | Rationale |
|--------------|-------------|-----------|
| `get_status` | `task:///{id}` resource | Resources are the MCP-native way to expose state |
| `list_tasks` | `task:///all` resource | Eliminates redundant data fetching patterns |
| `get_task_session_detail` | `task:///{id}/session` resource | Session details are static state, not actions |
| `stream_output` | Removed entirely | Real-time updates via progress notifications + subscriptions |
| `batch_spawn` | Removed | Use multiple `spawn_task` calls instead |
| `clear_tasks` | Merged into `cancel_task` | `cancel_task` now accepts `task_id: "all", clear: true` |
| `force_start` | Removed | Dependency handling is automatic |
| `recover_task` | Merged into `send_message` | Same underlying session resume mechanism |
| `resume_task` | Merged into `send_message` | Unified message-sending interface |
| `retry_task` | Automatic | Rate-limited tasks auto-retry with exponential backoff |
| `simulate_rate_limit` | Removed | Debug-only tool not needed in production |

### Environment Variable Changes

```bash
# OLD (single token only)
GITHUB_TOKEN=ghp_xxx

# NEW (supports comma-separated for multi-account)
GH_PAT_TOKEN=github_pat_xxx,github_pat_yyy

# Alternative formats still supported:
GITHUB_PAT_TOKENS=token1,token2,token3
GITHUB_PAT_TOKEN_1=token1
GITHUB_PAT_TOKEN_2=token2
```

---

## 🏗️ New Architecture

### Design Philosophy

The refactor follows these principles:

1. **Resources for State, Tools for Actions**: MCP Resources expose read-only state; tools perform mutations
2. **Progressive Disclosure**: `task:///all` for overview → `task:///{id}` for detail → `task:///{id}/session` for deep dive
3. **Self-Documenting**: Every tool description references the appropriate resource endpoints
4. **Multi-Account Resilience**: Automatic rotation on rate limits with zero configuration

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP Server (index.ts)                        │
├─────────────────────────────────────────────────────────────────────┤
│  Tools (4)                    │  Resources (4)                      │
│  ├─ spawn_task                │  ├─ system:///status               │
│  ├─ send_message              │  ├─ task:///all                    │
│  ├─ cancel_task               │  ├─ task:///{task_id}              │
│  └─ answer_question           │  └─ task:///{task_id}/session      │
├─────────────────────────────────────────────────────────────────────┤
│                        Services Layer                                │
│  ├─ AccountManager         Multi-token management, rotation         │
│  ├─ SDKClientManager       Per-CWD client pools                     │
│  ├─ SDKSpawner             Session lifecycle, retry logic           │
│  ├─ SDKSessionAdapter      Event → Task state bridging              │
│  ├─ TaskManager            State machine, persistence               │
│  ├─ QuestionRegistry       ask_user handling, answer routing        │
│  └─ SessionHooks           Pre/post tool use hooks                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Tools Reference

### 1. `spawn_task`

**Purpose:** Create a new task with Copilot SDK session.

**Input Schema:**
```json
{
  "prompt": "string (required) - Task description",
  "cwd": "string (optional) - Working directory",
  "model": "string (optional) - claude-sonnet-4-20250514 | claude-haiku-4.5",
  "task_type": "string (optional) - super-coder | super-researcher",
  "labels": ["array of strings (optional) - Custom labels"],
  "timeout": "number (optional) - Max execution time in ms",
  "depends_on": ["array of task IDs (optional) - Dependencies"]
}
```

**Example:**
```json
{
  "prompt": "Add TypeScript support to the project",
  "cwd": "/Users/dev/my-project",
  "model": "claude-sonnet-4-20250514",
  "labels": ["typescript", "setup"]
}
```

**Response:**
```
Task **clever-fox-42** spawned (pending).
Check status with MCP Resource `task:///clever-fox-42`.
```

### 2. `send_message`

**Purpose:** Send a follow-up message to an existing task session.

**Input Schema:**
```json
{
  "task_id": "string (optional) - Task ID to message",
  "session_id": "string (optional) - Direct session ID",
  "message": "string (optional, default: 'continue') - Message to send"
}
```

**Use Cases:**
- Continue a completed task: `{ "task_id": "abc123" }`
- Add follow-up instructions: `{ "task_id": "abc123", "message": "now add tests" }`
- Resume after rate limit: `{ "task_id": "abc123", "message": "continue" }`

**Response:**
```
✅ **Message sent** to session `session-uuid`

- **New task:** `zany-parrot-24`
- **Message:** "now add tests"
- **Continued from:** `clever-fox-42`
```

### 3. `cancel_task`

**Purpose:** Cancel running tasks or clear all tasks from workspace.

**Input Schema:**
```json
{
  "task_id": "string | string[] | 'all' (required)",
  "clear": "boolean (optional) - Required when task_id='all'",
  "confirm": "boolean (optional) - Required when clear=true"
}
```

**Examples:**

Cancel single task:
```json
{ "task_id": "clever-fox-42" }
```

Cancel multiple tasks:
```json
{ "task_id": ["task-1", "task-2", "task-3"] }
```

Clear all tasks:
```json
{ "task_id": "all", "clear": true, "confirm": true }
```

**Batch Response:**
```markdown
## Cancel Results (2/3 succeeded)

| Task | Result | Was |
|------|--------|-----|
| task-1 | ✅ | 🔄 running |
| task-2 | ✅ | ⏳ pending |

### Failed
| Task | Result | Reason |
|------|--------|--------|
| task-3 | ❌ | Not found |
```

### 4. `answer_question`

**Purpose:** Submit answers to pending questions from Copilot's `ask_user` tool.

**Input Schema:**
```json
{
  "task_id": "string (required) - Task with pending question",
  "answer": "string (required) - Answer to submit"
}
```

**Answer Formats:**
- **By number:** `"1"`, `"2"`, `"3"` - Selects choice by index
- **By text:** Exact text of a choice option
- **Custom:** `"CUSTOM: your freeform answer"`

**Example:**
```json
{
  "task_id": "clever-fox-42",
  "answer": "2"
}
```

**Response:**
```
✅ **Answer submitted for task clever-fox-42**

**Question:** Which testing framework should I use?
**Answer:** Jest
**Type:** Choice selection

Task execution will resume. Check progress with `task:///clever-fox-42`.
```

---

## 📊 Resources Reference

### 1. `system:///status`

**Purpose:** System-wide status including account health, task counts, and SDK stats.

**Response Schema:**
```json
{
  "accounts": {
    "total": 2,
    "available": 2,
    "current_index": 0,
    "rotation_count": 0,
    "failed_count": 0
  },
  "tasks": {
    "total": 5,
    "by_status": {
      "running": 1,
      "completed": 3,
      "failed": 0,
      "rate_limited": 0,
      "pending": 1,
      "waiting": 0
    },
    "with_pending_questions": ["task-id-1"]
  },
  "sdk": {
    "available": true,
    "pools": 1,
    "sessions": 3
  }
}
```

**Use Case:** Health checks, capacity planning, monitoring dashboards.

### 2. `task:///all`

**Purpose:** List all tasks with summary information.

**Response Schema:**
```json
{
  "count": 5,
  "tasks": [
    {
      "id": "clever-fox-42",
      "status": "completed",
      "round": 3,
      "total_messages": 12,
      "last_user_message": "Add error handling",
      "labels": ["typescript"],
      "has_pending_question": false,
      "can_send_message": true,
      "session_id": "session-uuid",
      "started": "2024-02-04T10:00:00Z",
      "ended": "2024-02-04T10:05:00Z"
    }
  ],
  "pending_questions": [
    {
      "task_id": "waiting-owl-99",
      "question": "Which database should I use?",
      "choices": ["PostgreSQL", "MongoDB", "SQLite"]
    }
  ]
}
```

**Key Fields:**
- `round`: Conversation round number (0, 1, 2...)
- `total_messages`: Total messages exchanged in session
- `last_user_message`: Last message sent to the session
- `can_send_message`: Whether `send_message` can be called
- `pending_questions`: Quick access to all waiting questions

### 3. `task:///{task_id}`

**Purpose:** Detailed status for a specific task.

**Response Schema:**
```json
{
  "id": "clever-fox-42",
  "status": "completed",
  "session_id": "session-uuid",
  "can_send_message": true,
  
  "progress": {
    "round": 3,
    "total_messages": 12,
    "last_user_message": "Add error handling"
  },
  
  "prompt_preview": "Add TypeScript support to the project...",
  "output_lines": 156,
  "output_tail": "✅ TypeScript configured successfully\n...",
  
  "started": "2024-02-04T10:00:00Z",
  "ended": "2024-02-04T10:05:00Z",
  "exit_code": 0,
  
  "cwd": "/Users/dev/my-project",
  "model": "claude-sonnet-4-20250514",
  "labels": ["typescript"],
  
  "pending_question": null,
  
  "retry_info": null,
  "quota_info": {
    "remaining_pct": 85,
    "reset_date": "2024-02-05T00:00:00Z"
  },
  "completion_metrics": {
    "api_calls": 8,
    "code_changes": {
      "added": 245,
      "removed": 12,
      "files": 5
    }
  },
  "session_metrics": {
    "turns": 3,
    "tokens": 15420,
    "tools": 4
  },
  
  "failure_context": null
}
```

**Progress Tracking:**
The `progress` object provides iteration awareness:
- `round`: Increments each time the assistant completes a turn
- `total_messages`: Cumulative message count
- `last_user_message`: Shows what was last sent (helps debug)

### 4. `task:///{task_id}/session`

**Purpose:** Deep session inspection with execution log.

**Response Schema:**
```json
{
  "task_id": "clever-fox-42",
  "status": "completed",
  "session_id": "session-uuid",
  "prompt_preview": "Add TypeScript support...",
  
  "execution_summary": {
    "turns": 3,
    "tool_calls": 8
  },
  
  "execution_log": [
    {
      "turn": 1,
      "role": "assistant",
      "tools": ["read_file", "write_file"],
      "output_preview": "I'll set up TypeScript..."
    },
    {
      "turn": 2,
      "role": "assistant", 
      "tools": ["run_command"],
      "output_preview": "Running npm install..."
    }
  ],
  
  "can_send_message": true,
  "session_metrics": {
    "turn_count": 3,
    "total_tokens": 15420
  }
}
```

**Use Case:** Debugging, understanding what tools were called, session replay.

---

## 🔐 Multi-Account Support

### Configuration

```bash
# Comma-separated tokens (recommended)
GH_PAT_TOKEN=github_pat_xxx,github_pat_yyy,github_pat_zzz

# Alternative: numbered environment variables
GITHUB_PAT_TOKEN_1=github_pat_xxx
GITHUB_PAT_TOKEN_2=github_pat_yyy

# Alternative: GITHUB_PAT_TOKENS (comma-separated)
GITHUB_PAT_TOKENS=token1,token2,token3
```

### Rotation Behavior

1. **Detection:** Rate limits (HTTP 429) and server errors (5xx) are detected
2. **Rotation:** System automatically switches to the next available token
3. **Resume:** Active session resumes with new token (if resumable)
4. **Fallback:** Failed tokens are marked and skipped until reset

### Monitoring

Check `system:///status` for account health:

```json
{
  "accounts": {
    "total": 3,
    "available": 2,
    "current_index": 1,
    "rotation_count": 3,
    "failed_count": 1
  }
}
```

### Implementation Details

**AccountManager** (`src/services/account-manager.ts`):
- Thread-safe token rotation
- Failed token tracking with automatic recovery
- Rotation callbacks for session resume

**SDKClientManager** (`src/services/sdk-client-manager.ts`):
- Per-CWD client pools
- Automatic client recreation on rotation
- Graceful shutdown handling

---

## 🧪 Test Suite

### Test Files

| File | Tests | Coverage |
|------|-------|----------|
| `mcp-test.ts` | Quick smoke test | Basic connectivity |
| `mcp-test-comprehensive.ts` | 54 tests | All tools, resources, task lifecycle |
| `mcp-test-multitoken.ts` | 19 tests | Multi-account, edge cases, error handling |

### Running Tests

```bash
# Quick test (basic connectivity)
npx tsx mcp-test.ts

# Comprehensive test (all features)
npx tsx mcp-test-comprehensive.ts

# Multi-token & edge case test
npx tsx mcp-test-multitoken.ts
```

### Comprehensive Test Sections

1. **Tool Listing** - All 4 tools present with correct descriptions
2. **Resource Listing** - All 4 resources and templates
3. **System Status** - Account info, task counts, SDK stats
4. **Spawn Task (Basic)** - Different task types, labels, models
5. **Task Status Polling** - Progress tracking (round, messages)
6. **Task Detail Resource** - All fields present and correct
7. **Session Detail Resource** - Execution log, summary
8. **Task:///all Resource** - List with progress data
9. **Send Message Tool** - Follow-up messages work
10. **Cancel Task (Single)** - SIGTERM sent correctly
11. **Cancel Task (Batch)** - Array of IDs works
12. **Error Handling** - Invalid inputs handled gracefully
13. **Answer Question** - Validation works correctly
14. **Clear All Tasks** - Confirm required, clears properly

### Edge Cases Tested

- Empty prompt → rejected
- Invalid model name → rejected
- Non-existent task ID → error returned
- send_message to non-existent task → rejected
- send_message with empty message → defaults to "continue"
- Mixed valid/invalid cancel IDs → gracefully handled
- Non-existent resource URIs → throw errors
- answer_question on task without pending question → error

---

## 🔄 Migration Guide

### From `list_tasks` to `task:///all`

**Before:**
```javascript
const result = await client.callTool({ name: 'list_tasks', arguments: {} });
const tasks = JSON.parse(result.content[0].text);
```

**After:**
```javascript
const result = await client.readResource({ uri: 'task:///all' });
const tasks = JSON.parse(result.contents[0].text);
```

### From `get_status` to `task:///{id}`

**Before:**
```javascript
const result = await client.callTool({ 
  name: 'get_status', 
  arguments: { task_id: 'abc123' } 
});
```

**After:**
```javascript
const result = await client.readResource({ uri: 'task:///abc123' });
```

### From `clear_tasks` to `cancel_task`

**Before:**
```javascript
await client.callTool({ name: 'clear_tasks', arguments: { confirm: true } });
```

**After:**
```javascript
await client.callTool({ 
  name: 'cancel_task', 
  arguments: { task_id: 'all', clear: true, confirm: true } 
});
```

### From `resume_task` to `send_message`

**Before:**
```javascript
await client.callTool({ name: 'resume_task', arguments: { task_id: 'abc123' } });
```

**After:**
```javascript
await client.callTool({ 
  name: 'send_message', 
  arguments: { task_id: 'abc123', message: 'continue' } 
});
```

---

## 📁 Files Changed

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/services/account-manager.ts` | 302 | Multi-token management, rotation |
| `src/services/sdk-client-manager.ts` | 394 | Per-CWD client pools |
| `src/services/sdk-session-adapter.ts` | 1050 | Event → Task state bridging |
| `src/services/sdk-spawner.ts` | 499 | Session lifecycle, retry logic |
| `src/services/question-registry.ts` | 336 | ask_user handling |
| `src/services/session-hooks.ts` | 286 | Pre/post tool hooks |
| `src/tools/send-message.ts` | 173 | New unified message tool |
| `src/tools/answer-question.ts` | 138 | Question answering tool |
| `mcp-test.ts` | 175 | Quick test script |
| `mcp-test-comprehensive.ts` | 483 | Full test suite |
| `mcp-test-multitoken.ts` | 320 | Multi-account tests |
| `docs/ARCHITECTURE.md` | - | Architecture documentation |

### Modified Files

| File | Changes | Purpose |
|------|---------|---------|
| `src/index.ts` | +464 lines | MCP Resource handlers, enhanced task mapping |
| `src/tools/cancel-task.ts` | +170 lines | Batch cancel, clear all support |
| `src/tools/spawn-task.ts` | +17 lines | Updated descriptions |
| `src/services/task-manager.ts` | +128 lines | Session tracking, message stats |
| `src/services/task-status-mapper.ts` | +164 lines | Progress extraction |
| `src/services/retry-queue.ts` | +137 lines | Enhanced retry logic |
| `src/types.ts` | +191 lines | New type definitions |

### Deleted Files

| File | Lines | Reason |
|------|-------|--------|
| `src/tools/get-status.ts` | -492 | Replaced by `task:///{id}` resource |
| `src/tools/list-tasks.ts` | -83 | Replaced by `task:///all` resource |
| `src/tools/stream-output.ts` | -101 | Replaced by progress notifications |
| `src/tools/batch-spawn.ts` | -188 | Use multiple spawn_task calls |
| `src/tools/clear-tasks.ts` | -52 | Merged into cancel_task |
| `src/tools/force-start.ts` | -48 | Automatic dependency handling |
| `src/tools/recover-task.ts` | -102 | Merged into send_message |
| `src/tools/resume-task.ts` | -58 | Merged into send_message |
| `src/tools/retry-task.ts` | -72 | Automatic retry on rate limit |
| `src/tools/simulate-rate-limit.ts` | -84 | Debug-only, not needed |
| `src/services/process-spawner.ts` | -575 | Replaced by SDK spawner |
| `src/services/copilot-switch.ts` | -269 | Replaced by account manager |

---

## 📝 Commits

| Commit | Description |
|--------|-------------|
| `94c4d92` | before cleaning up - MCP resources refactor complete |
| `a14b22c` | cleanup: remove bloat, add message tracking to resources |
| `03a9402` | fix: add GH_PAT_TOKEN env var support, link copilot-sdk |
| `3a67845` | test: add persistent MCP client test script |
| `c340ff1` | test: add comprehensive MCP server test suite (54 tests, 100% pass) |
| `8a8205c` | fix: support comma-separated tokens in GH_PAT_TOKEN, add multi-token tests |

---

## ✅ Checklist

- [x] All 4 tools working correctly
- [x] All 4 resources returning correct data
- [x] Multi-account detection (2 tokens)
- [x] Rotation logic ready for rate limits
- [x] 54 comprehensive tests passing
- [x] 19 edge case tests passing
- [x] Progress tracking (round, total_messages) working
- [x] Batch cancel working
- [x] Clear all with confirmation working
- [x] Error handling for invalid inputs
- [x] Tool descriptions reference MCP Resources
- [x] Backward compatibility notes documented

---

## 🚀 Next Steps

1. **Monitor rotation in production** - Verify automatic failover works under real rate limits
2. **Add quota prediction** - Use remaining_pct to preemptively rotate before hitting limits
3. **Session persistence** - Consider persisting session IDs for cross-restart recovery
4. **Metrics dashboard** - Build on `system:///status` for observability

---

**Total Impact:** This refactor reduces cognitive load for MCP clients by 67% (12 → 4 tools) while providing richer data through 4 well-structured resources. Multi-account support adds resilience for high-volume usage patterns.
