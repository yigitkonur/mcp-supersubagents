#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  GetTaskRequestSchema, ListTasksRequestSchema, CancelTaskRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
  McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { spawnTaskTool, handleSpawnTask } from './tools/spawn-task.js';
import { getTaskStatusTool, handleGetTaskStatus } from './tools/get-status.js';
import { listTasksTool, handleListTasks } from './tools/list-tasks.js';
import { resumeTaskTool, handleResumeTask } from './tools/resume-task.js';
import { clearTasksTool, handleClearTasks } from './tools/clear-tasks.js';
import { retryTaskTool, handleRetryTask } from './tools/retry-task.js';
import { cancelTaskTool, handleCancelTask } from './tools/cancel-task.js';
import { recoverTaskTool, handleRecoverTask } from './tools/recover-task.js';
import { forceStartTool, handleForceStart } from './tools/force-start.js';
import { batchSpawnTool, handleBatchSpawn } from './tools/batch-spawn.js';
import { streamOutputTool, handleStreamOutput } from './tools/stream-output.js';
import { simulateRateLimitTool, handleSimulateRateLimit } from './tools/simulate-rate-limit.js';
import { taskManager } from './services/task-manager.js';
import { clientContext } from './services/client-context.js';
import { checkCopilotInstalled, checkClaudeCliInstalled } from './services/process-spawner.js';
import { buildMCPTask } from './services/task-status-mapper.js';
import { progressRegistry } from './services/progress-registry.js';
import { subscriptionRegistry, taskIdToUri, uriToTaskId } from './services/subscription-registry.js';
import { isSwitchAvailable } from './services/copilot-switch.js';
import { mcpText } from './utils/format.js';
import { TaskStatus } from './types.js';
import type { ToolContext } from './types.js';

// Feature flags (off by default for cost control)
const ENABLE_STREAMING = process.env.ENABLE_STREAMING === 'true';

const server = new Server(
  { name: 'copilot-agent', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      tasks: {
        list: {},
        cancel: {},
        requests: { tools: { call: {} } },
      },
      resources: {
        subscribe: true,
        listChanged: true,
      },
    },
  }
);

// Load persisted tasks immediately using server cwd as a fallback.
taskManager.setCwd(clientContext.getDefaultCwd());

// Register retry callback for rate-limited tasks
taskManager.onRetry(async (task) => {
  const { spawnCopilotProcess } = await import('./services/process-spawner.js');

  console.error(`[index] Retrying task ${task.id}: "${task.prompt.slice(0, 50)}..."`);

  try {
    // Spawn a new process with the same parameters, carrying forward retry info
    const newTaskId = await spawnCopilotProcess({
      prompt: task.prompt,
      cwd: task.cwd,
      model: task.model,
      autonomous: task.autonomous ?? true,
      retryInfo: task.retryInfo,
      fallbackAttempted: task.fallbackAttempted,
    });
    return newTaskId;
  } catch (err) {
    console.error(`[index] Failed to retry task ${task.id}:`, err);
    return undefined;
  }
});

// Register execute callback for waiting tasks (dependencies satisfied)
taskManager.onExecute(async (task) => {
  const { executeWaitingTask } = await import('./services/process-spawner.js');

  console.error(`[index] Executing waiting task ${task.id}: "${task.prompt.slice(0, 50)}..."`);
  await executeWaitingTask(task);
});

// --- Progress & Resource notification wiring ---

const TERMINAL_STATUSES = [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT];
const resourceUpdateTimers = new Map<string, NodeJS.Timeout>();

// Single onOutput registration: forwards to progress + debounced resource updates
taskManager.onOutput((taskId, line) => {
  // 1. Forward to progress registry (if client registered a progressToken)
  progressRegistry.sendProgress(taskId, line);

  // 2. Debounced resource updated notification (max 1/sec per task)
  const uri = taskIdToUri(taskId);
  if (subscriptionRegistry.isSubscribed(uri) && !resourceUpdateTimers.has(taskId)) {
    resourceUpdateTimers.set(taskId, setTimeout(() => {
      resourceUpdateTimers.delete(taskId);
      server.sendResourceUpdated({ uri }).catch(() => {});
    }, 1000));
  }
});

// Status changes: task notifications + progress + resource updates
taskManager.onStatusChange((task, previousStatus) => {
  // 1. MCP Task status notification
  const mcpTask = buildMCPTask(task);
  server.notification({
    method: 'notifications/tasks/status',
    params: { ...mcpTask },
  }).catch(() => {});

  // 2. Progress notification for state transition
  progressRegistry.sendProgress(task.id, `Status: ${previousStatus} → ${task.status}`);

  // 3. Unregister progress on terminal states
  if (TERMINAL_STATUSES.includes(task.status)) {
    progressRegistry.unregister(task.id);
  }

  // 4. Resource updated notification (if subscribed)
  const uri = taskIdToUri(task.id);
  if (subscriptionRegistry.isSubscribed(uri)) {
    server.sendResourceUpdated({ uri }).catch(() => {});
  }
});

// Task created: resource list changed
taskManager.onTaskCreated(() => {
  server.sendResourceListChanged().catch(() => {});
});

// Task deleted: cleanup subscription + resource list changed
taskManager.onTaskDeleted((taskId) => {
  progressRegistry.unregister(taskId);
  subscriptionRegistry.unsubscribe(taskIdToUri(taskId));
  server.sendResourceListChanged().catch(() => {});
});

// --- Initialization ---

server.oninitialized = async () => {
  try {
    const result = await server.listRoots();
    if (result?.roots?.length) {
      clientContext.setRoots(result.roots);
    }
  } catch {
    // Client may not support roots - use server cwd as fallback
  }

  // Load persisted tasks for this workspace (also triggers auto-retry for rate-limited tasks)
  const cwd = clientContext.getDefaultCwd();
  taskManager.setCwd(cwd);
};

// --- Tool handlers ---

const tools = [
  spawnTaskTool, getTaskStatusTool, listTasksTool, resumeTaskTool,
  clearTasksTool, retryTaskTool, cancelTaskTool, recoverTaskTool, forceStartTool, batchSpawnTool,
  ...(ENABLE_STREAMING ? [streamOutputTool] : []),
  simulateRateLimitTool,
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const ctx: ToolContext = {
    progressToken: extra._meta?.progressToken,
    sendNotification: extra.sendNotification,
  };

  switch (name) {
    case 'spawn_task': return handleSpawnTask(args, ctx);
    case 'batch_spawn': return handleBatchSpawn(args, ctx);
    case 'resume_task': return handleResumeTask(args, ctx);
    case 'get_status': return handleGetTaskStatus(args);
    case 'list_tasks': return handleListTasks(args);
    case 'clear_tasks': return handleClearTasks(args);
    case 'retry_task': return handleRetryTask(args);
    case 'cancel_task': return handleCancelTask(args);
    case 'recover_task': return handleRecoverTask(args);
    case 'force_start': return handleForceStart(args);
    case 'stream_output': return ENABLE_STREAMING
      ? handleStreamOutput(args)
      : mcpText('**Error:** `stream_output` is disabled (experimental). Set `ENABLE_STREAMING=true` to enable.');
    case 'simulate_rate_limit': return handleSimulateRateLimit(args);
    default: return mcpText(`**Error:** Unknown tool \`${name}\``);
  }
});

// --- MCP Task Primitive handlers ---

server.setRequestHandler(GetTaskRequestSchema, async (request) => {
  const task = taskManager.getTask(request.params.taskId);
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
  }
  return buildMCPTask(task);
});

server.setRequestHandler(ListTasksRequestSchema, async (request) => {
  const PAGE_SIZE = 50;
  const allTasks = taskManager.getAllTasks();
  const startIndex = request.params?.cursor ? parseInt(request.params.cursor, 10) : 0;
  const page = allTasks.slice(startIndex, startIndex + PAGE_SIZE);
  return {
    tasks: page.map(buildMCPTask),
    nextCursor: startIndex + PAGE_SIZE < allTasks.length ? String(startIndex + PAGE_SIZE) : undefined,
  };
});

server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
  const { taskId } = request.params;
  const task = taskManager.getTask(taskId);
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }
  const result = taskManager.cancelTask(taskId);
  if (!result.success) {
    throw new McpError(ErrorCode.InvalidParams, result.error || 'Cannot cancel task');
  }
  return buildMCPTask(taskManager.getTask(taskId)!);
});

// --- MCP Resource handlers ---

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: taskManager.getAllTasks().map(task => ({
      uri: taskIdToUri(task.id),
      name: task.id,
      description: `Task ${task.id} (${task.status})` + (task.labels?.length ? ` [${task.labels.join(', ')}]` : ''),
      mimeType: 'application/json',
    })),
  };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{
    uriTemplate: 'task:///{task_id}',
    name: 'Task',
    description: 'A background Copilot CLI task with full state and output tail.',
    mimeType: 'application/json',
  }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const taskId = uriToTaskId(request.params.uri);
  if (!taskId) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid task URI: ${request.params.uri}`);
  }
  const task = taskManager.getTask(taskId);
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }

  const data = {
    id: task.id,
    status: task.status,
    prompt: task.prompt.slice(0, 500),
    output_lines: task.output.length,
    output_tail: task.output.slice(-50).join('\n'),
    pid: task.pid,
    sessionId: task.sessionId,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    error: task.error,
    cwd: task.cwd,
    model: task.model,
    dependsOn: task.dependsOn,
    labels: task.labels,
    retryInfo: task.retryInfo,
    timeout: task.timeout,
    timeoutAt: task.timeoutAt,
  };

  return {
    contents: [{
      uri: request.params.uri,
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
});

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptionRegistry.subscribe(request.params.uri);
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscriptionRegistry.unsubscribe(request.params.uri);
  return {};
});

// --- Start server ---

async function main() {
  if (!checkCopilotInstalled()) console.error('Warning: Copilot CLI not found');
  if (isSwitchAvailable()) {
    console.error('Info: Copilot account switching available');
  } else {
    console.error('Info: Copilot account switching not available (no ~/bin/copilot-switch)');
  }
  if (!checkClaudeCliInstalled()) {
    console.error('Warning: Claude CLI not found - fallback on rate limit will not be available');
  } else {
    console.error('Info: Claude CLI available for rate limit fallback');
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGINT', () => { taskManager.shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { taskManager.shutdown(); process.exit(0); });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
