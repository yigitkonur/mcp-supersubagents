# Session Metrics and MCP Resources

This document covers what metrics a provider should populate and how they surface to MCP clients.

---

## 1. SessionMetrics — The Unified Metrics Object

Every task can carry a `sessionMetrics` field that provides observability into the execution:

```typescript
// src/types.ts:190-222
export interface SessionMetrics {
  quotas: Record<string, QuotaInfo>;
  toolMetrics: Record<string, ToolMetrics>;
  activeSubagents: SubagentInfo[];
  completedSubagents: SubagentInfo[];
  turnCount: number;
  totalTokens: { input: number; output: number };
}
```

Updated via `taskManager.updateTask(taskId, { sessionMetrics: { ... } })`.

## 2. Metric Types

### `CompletionMetrics`

Populated from the SDK's shutdown event (Copilot provider) or stream finish (Claude provider):

```typescript
export interface CompletionMetrics {
  totalApiCalls: number;
  totalApiDurationMs: number;
  codeChanges: {
    linesAdded: number;
    linesRemoved: number;
    filesModified: string[];
  };
  modelUsage: Record<string, {
    requests: number;
    cost: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
  sessionStartTime: number;
  currentModel?: string;
}
```

Stored as `task.completionMetrics`. Populated by:
- **Copilot**: `handleSessionShutdown()` extracts from `event.data.modelMetrics`
- **Claude**: Basic version from stream `finish` parts

### `QuotaInfo`

Tracks API quota consumption per tier:

```typescript
export interface QuotaInfo {
  tier: string;
  remainingPercentage: number;
  usedRequests: number;
  entitlementRequests: number;
  isUnlimited: boolean;
  overage: number;
  resetDate?: string;
  lastUpdated: string;
}
```

Populated by:
- **Copilot**: `handleUsage()` extracts from `event.data.quotaSnapshots`
- **Claude**: Not populated (no quota API)

### `ToolMetrics`

Per-tool execution statistics:

```typescript
export interface ToolMetrics {
  toolName: string;
  mcpServer?: string;
  mcpToolName?: string;
  executionCount: number;
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
  lastExecutedAt?: string;
}
```

Populated by:
- **Copilot**: `handleToolStart()` + `handleToolComplete()` maintain per-binding Maps
- **Claude**: Basic tracking via `tool-call`/`tool-result` stream parts

### `SubagentInfo`

Tracks parallel sub-agents (fleet mode):

```typescript
export interface SubagentInfo {
  agentName: string;
  agentDisplayName?: string;
  agentDescription?: string;
  toolCallId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  endedAt?: string;
  error?: string;
  tools?: string[];
}
```

Populated by:
- **Copilot**: `handleSubagentSelected/Started/Completed/Failed()` event handlers
- **Claude**: Not populated (no sub-agent concept in stream)

### `FailureContext`

Structured error information:

```typescript
export interface FailureContext {
  errorType: string;
  statusCode?: number;
  providerCallId?: string;
  message: string;
  stack?: string;
  recoverable: boolean;
}
```

Populated by:
- **Copilot**: `handleSessionError()` extracts from `event.data`
- **Claude**: Created from stream `error` parts

## 3. MCP Resources That Surface Metrics

| URI | Content | Key Metrics Included |
|-----|---------|---------------------|
| `system:///status` | Global server health | Account stats, SDK health, task counts |
| `task:///all` | All tasks summary | Status, progress, pending questions per task |
| `task:///{id}` | Full task detail | Output tail, sessionMetrics, completionMetrics, quotaInfo, failureContext |
| `task:///{id}/session` | Execution log | Tool calls, turn data, detailed session trace |

## 4. Resource Notification Debouncing

Resource change notifications are debounced to maximum 1 per second per task:

```typescript
// subscriptionRegistry tracks last notification time per URI
// Notifications more frequent than 1/sec are dropped
```

This prevents output-heavy tasks from flooding the MCP client with notifications.

## 5. What Your Provider Should Populate

### Required (minimum viable)

| Metric | How | Why |
|--------|-----|-----|
| `sessionMetrics.turnCount` | Increment on each model turn | Basic progress indicator |
| `sessionMetrics.totalTokens` | Sum input/output tokens | Cost tracking |

```typescript
taskManager.updateTask(taskId, {
  sessionMetrics: {
    turnCount: currentTurn,
    totalTokens: { input: totalInput, output: totalOutput },
    quotas: {},
    toolMetrics: {},
    activeSubagents: [],
    completedSubagents: [],
  },
});
```

### Recommended

| Metric | How | Why |
|--------|-----|-----|
| `toolMetrics` | Track start/end times per tool | Performance debugging |
| `completionMetrics` | Populate on completion | Code change tracking |
| `failureContext` | Populate on error | Error diagnosis |

### Nice-to-Have

| Metric | How | Why |
|--------|-----|-----|
| `quotaInfo` | Extract from SDK quota API | Proactive rate limit avoidance |
| `SubagentInfo` | Track parallel agents | Fleet mode observability |

### Update Frequency

The Copilot adapter throttles metrics updates to once per second:

```typescript
const SESSION_METRICS_UPDATE_INTERVAL_MS = 1000;

if (!force && now - binding.lastMetricsUpdateAt < SESSION_METRICS_UPDATE_INTERVAL_MS) {
  return;  // Skip update
}
```

Follow this pattern to avoid excessive `updateTask()` calls that trigger persistence.

---

**Previous:** [08 — Supporting Services](./08-supporting-services.md) · **Next:** [10 — Mode System and Templates](./10-mode-system-and-templates.md)
