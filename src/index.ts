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
import { cancelTaskTool, handleCancelTask } from './tools/cancel-task.js';
import { sendMessageTool, handleSendMessage } from './tools/send-message.js';
import { answerQuestionTool, handleAnswerQuestion } from './tools/answer-question.js';
import { streamOutputTool, handleStreamOutput } from './tools/stream-output.js';
import { taskManager } from './services/task-manager.js';
import { clientContext } from './services/client-context.js';
import { checkSDKAvailable, shutdownSDK, getSDKStats } from './services/sdk-spawner.js';
import { sdkClientManager } from './services/sdk-client-manager.js';
import { accountManager } from './services/account-manager.js';
import { buildMCPTask } from './services/task-status-mapper.js';
import { progressRegistry } from './services/progress-registry.js';
import { subscriptionRegistry, taskIdToUri, uriToTaskId } from './services/subscription-registry.js';
import { questionRegistry } from './services/question-registry.js';
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

// Register retry callback for rate-limited tasks (using SDK spawner)
taskManager.onRetry(async (task) => {
  const { spawnCopilotTask } = await import('./services/sdk-spawner.js');

  console.error(`[index] Retrying task ${task.id}: "${task.prompt.slice(0, 50)}..."`);

  try {
    // Spawn a new SDK session with the same parameters, carrying forward retry info
    const newTaskId = await spawnCopilotTask({
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
  const { executeWaitingTask } = await import('./services/sdk-spawner.js');

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

  // Initialize SDK client manager with multi-account support
  // This resets account rotation to first token on each MCP connect
  // PAT tokens are configured via environment variables:
  // - GITHUB_PAT_TOKENS (comma-separated list)
  // - GITHUB_PAT_TOKEN_1, GITHUB_PAT_TOKEN_2, etc.
  // - GITHUB_TOKEN or GH_TOKEN (single token fallback)
  sdkClientManager.initialize();
  
  // Load persisted tasks for this workspace (also triggers auto-retry for rate-limited tasks)
  const cwd = clientContext.getDefaultCwd();
  taskManager.setCwd(cwd);
  
  console.error(`[index] MCP initialized - accounts: ${accountManager.getTokenCount()}, cwd: ${cwd}`);
};

// --- Tool handlers ---

// Only 4 tools - status/listing moved to MCP Resources, handoff automated on backend
const tools = [
  spawnTaskTool,
  sendMessageTool,
  cancelTaskTool,
  answerQuestionTool,
  ...(ENABLE_STREAMING ? [streamOutputTool] : []),
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
    case 'send_message': return handleSendMessage(args, ctx);
    case 'cancel_task': return handleCancelTask(args);
    case 'answer_question': return handleAnswerQuestion(args);
    case 'stream_output': return ENABLE_STREAMING
      ? handleStreamOutput(args)
      : mcpText('**Error:** `stream_output` is disabled. Set `ENABLE_STREAMING=true` to enable.');
    default: return mcpText(`**Error:** Unknown tool \`${name}\`. Use MCP Resources for status: task:///all or task:///{id}`);
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
// Resources replace list_tasks, get_status, get_task_session_detail tools
// Use: task:///all for task list, task:///{id} for details, task:///{id}/session for execution log

const TASK_ALL_URI = 'task:///all';
const SYSTEM_STATUS_URI = 'system:///status';

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const allTasks = taskManager.getAllTasks();
  const pendingQuestions = allTasks.filter(t => t.pendingQuestion).length;
  const running = allTasks.filter(t => t.status === TaskStatus.RUNNING).length;
  
  // Build resources list: system status + all tasks summary + individual tasks
  const resources = [
    {
      uri: SYSTEM_STATUS_URI,
      name: 'System Status',
      description: `Accounts: ${accountManager.getTokenCount()}, Tasks: ${allTasks.length} (${running} running${pendingQuestions ? `, ${pendingQuestions} ⏸️` : ''})`,
      mimeType: 'application/json',
    },
    {
      uri: TASK_ALL_URI,
      name: 'All Tasks',
      description: `${allTasks.length} tasks - replaces list_tasks tool`,
      mimeType: 'application/json',
    },
    ...allTasks.map(task => {
      let desc = `${task.status}`;
      if (task.pendingQuestion) desc += ' ⏸️❓';
      if (task.labels?.length) desc += ` [${task.labels.join(', ')}]`;
      return {
        uri: taskIdToUri(task.id),
        name: task.id,
        description: desc,
        mimeType: 'application/json',
      };
    }),
  ];
  
  return { resources };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: 'task:///{task_id}',
      name: 'Task Details',
      description: 'Full task status, metrics, output, and session info. Replaces get_status tool.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'task:///{task_id}/session',
      name: 'Task Session',
      description: 'Execution log with tool calls and AI responses. Replaces get_task_session_detail tool.',
      mimeType: 'application/json',
    },
  ],
}));

// Helper: Parse output to execution log entries
function parseOutputToExecutionLog(output: string[], mode: 'compact' | 'verbose' = 'compact') {
  const entries: Array<{ turn: number; tools: Array<{ name: string; duration?: string }> }> = [];
  let currentTurn = 0;
  let currentEntry: { turn: number; tools: Array<{ name: string; duration?: string }> } | null = null;

  for (const line of output) {
    if (line.includes('[assistant] Message complete') || line.includes('[turn]')) {
      if (currentEntry) entries.push(currentEntry);
      currentTurn++;
      currentEntry = { turn: currentTurn, tools: [] };
      continue;
    }
    if (line.includes('[tool] Starting:')) {
      const match = line.match(/\[tool\] Starting: (\S+)/);
      if (match && currentEntry) {
        currentEntry.tools.push({ name: match[1] });
      }
    }
    if (line.includes('[tool] Completed:')) {
      const match = line.match(/\[tool\] Completed: (\S+) \((\d+)ms\)/);
      if (match && currentEntry && currentEntry.tools.length > 0) {
        const lastTool = currentEntry.tools[currentEntry.tools.length - 1];
        if (lastTool) lastTool.duration = `${match[2]}ms`;
      }
    }
  }
  if (currentEntry) entries.push(currentEntry);
  return entries;
}

// Helper: Check if task can receive messages
function canSendMessage(task: { status: TaskStatus; sessionId?: string }): boolean {
  const allowedStatuses = [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.RATE_LIMITED, TaskStatus.TIMED_OUT];
  return !!(task.sessionId && allowedStatuses.includes(task.status));
}

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  
  // Handle system:///status
  if (uri === SYSTEM_STATUS_URI) {
    const allTasks = taskManager.getAllTasks();
    const stats = accountManager.getStats();
    const sdkStats = getSDKStats();
    
    const data = {
      accounts: {
        total: stats.totalTokens,
        current_index: stats.currentIndex,
        available: stats.availableTokens,
        failed_count: stats.failedTokens,
        rotation_count: stats.rotationCount,
        last_rotation: stats.lastRotation,
      },
      tasks: {
        total: allTasks.length,
        by_status: {
          running: allTasks.filter(t => t.status === TaskStatus.RUNNING).length,
          completed: allTasks.filter(t => t.status === TaskStatus.COMPLETED).length,
          failed: allTasks.filter(t => t.status === TaskStatus.FAILED).length,
          rate_limited: allTasks.filter(t => t.status === TaskStatus.RATE_LIMITED).length,
          pending: allTasks.filter(t => t.status === TaskStatus.PENDING).length,
          waiting: allTasks.filter(t => t.status === TaskStatus.WAITING).length,
        },
        with_pending_questions: allTasks.filter(t => t.pendingQuestion).map(t => t.id),
      },
      sdk: sdkStats,
    };
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      }],
    };
  }
  
  // Handle task:///all - replaces list_tasks
  if (uri === TASK_ALL_URI) {
    const allTasks = taskManager.getAllTasks();
    
    const data = {
      count: allTasks.length,
      tasks: allTasks.map(task => ({
        id: task.id,
        status: task.status,
        labels: task.labels,
        has_pending_question: !!task.pendingQuestion,
        pending_question: task.pendingQuestion?.question,
        can_send_message: canSendMessage(task),
        session_id: task.sessionId,
        started: task.startTime,
        ended: task.endTime,
      })),
      pending_questions: allTasks
        .filter(t => t.pendingQuestion)
        .map(t => ({
          task_id: t.id,
          question: t.pendingQuestion!.question,
          choices: t.pendingQuestion!.choices,
        })),
    };
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      }],
    };
  }
  
  // Handle task:///{id}/session - replaces get_task_session_detail
  if (uri.includes('/session')) {
    const taskId = uri.replace('task:///', '').replace('/session', '');
    const task = taskManager.getTask(taskId);
    if (!task) {
      throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
    }
    
    const executionLog = parseOutputToExecutionLog(task.output);
    const toolCount = executionLog.reduce((sum, e) => sum + e.tools.length, 0);
    
    const data = {
      task_id: task.id,
      status: task.status,
      session_id: task.sessionId,
      prompt_preview: task.prompt.slice(0, 300) + (task.prompt.length > 300 ? '...' : ''),
      execution_summary: {
        turns: executionLog.length,
        tool_calls: toolCount,
      },
      execution_log: executionLog,
      can_send_message: canSendMessage(task),
      session_metrics: task.sessionMetrics ? {
        turn_count: task.sessionMetrics.turnCount,
        total_tokens: (task.sessionMetrics.totalTokens?.input || 0) + (task.sessionMetrics.totalTokens?.output || 0),
      } : undefined,
    };
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      }],
    };
  }
  
  // Handle task:///{id} - replaces get_status
  const taskId = uriToTaskId(uri);
  if (!taskId) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid resource URI: ${uri}`);
  }
  const task = taskManager.getTask(taskId);
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }

  const data = {
    id: task.id,
    status: task.status,
    session_id: task.sessionId,
    can_send_message: canSendMessage(task),
    
    // Prompt and output
    prompt_preview: task.prompt.slice(0, 500) + (task.prompt.length > 500 ? '...' : ''),
    output_lines: task.output.length,
    output_tail: task.output.slice(-50).join('\n'),
    
    // Timing
    started: task.startTime,
    ended: task.endTime,
    exit_code: task.exitCode,
    error: task.error,
    
    // Config
    cwd: task.cwd,
    model: task.model,
    labels: task.labels,
    depends_on: task.dependsOn,
    
    // Pending question (if any)
    pending_question: task.pendingQuestion ? {
      question: task.pendingQuestion.question,
      choices: task.pendingQuestion.choices,
      allow_freeform: task.pendingQuestion.allowFreeform,
    } : undefined,
    
    // Rate limit info
    retry_info: task.retryInfo ? {
      reason: task.retryInfo.reason,
      retry_count: task.retryInfo.retryCount,
      max_retries: task.retryInfo.maxRetries,
      next_retry: task.retryInfo.nextRetryTime,
    } : undefined,
    
    // SDK metrics
    quota_info: task.quotaInfo ? {
      remaining_pct: task.quotaInfo.remainingPercentage,
      reset_date: task.quotaInfo.resetDate,
    } : undefined,
    completion_metrics: task.completionMetrics ? {
      api_calls: task.completionMetrics.totalApiCalls,
      code_changes: {
        added: task.completionMetrics.codeChanges.linesAdded,
        removed: task.completionMetrics.codeChanges.linesRemoved,
        files: task.completionMetrics.codeChanges.filesModified.length,
      },
    } : undefined,
    session_metrics: task.sessionMetrics ? {
      turns: task.sessionMetrics.turnCount,
      tokens: (task.sessionMetrics.totalTokens?.input || 0) + (task.sessionMetrics.totalTokens?.output || 0),
      tools: Object.keys(task.sessionMetrics.toolMetrics || {}).length,
    } : undefined,
    
    // Failure context
    failure_context: task.failureContext ? {
      type: task.failureContext.errorType,
      status_code: task.failureContext.statusCode,
      recoverable: task.failureContext.recoverable,
    } : undefined,
  };

  return {
    contents: [{
      uri,
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

// --- Question notification wiring ---
// Register callback to send MCP notifications when questions arrive
questionRegistry.onQuestionAsked((taskId, question) => {
  // Send MCP notification for pending question
  server.notification({
    method: 'notifications/tasks/question',
    params: {
      taskId,
      question: question.question,
      choices: question.choices,
      allowFreeform: question.allowFreeform,
      askedAt: question.askedAt,
      sessionId: question.sessionId,
    },
  }).catch((err) => {
    console.error(`[index] Failed to send question notification for task ${taskId}:`, err);
  });

  // Also send progress notification for clients that support progress but not custom notifications
  progressRegistry.sendProgress(taskId, `⏸️ QUESTION: ${question.question}`);

  // Send resource update for subscribed clients
  const uri = taskIdToUri(taskId);
  if (subscriptionRegistry.isSubscribed(uri)) {
    server.sendResourceUpdated({ uri });
  }
});

// --- Start server ---

async function main() {
  // Initialize account manager early to read PAT tokens from env
  accountManager.initialize();
  
  // Check SDK availability
  const sdkAvailable = await checkSDKAvailable().catch(() => false);
  if (!sdkAvailable) {
    console.error('Warning: Copilot SDK/CLI not available - tasks will fail');
  } else {
    console.error('Info: Copilot SDK initialized successfully');
  }
  
  // Log multi-account status
  const tokenCount = accountManager.getTokenCount();
  if (tokenCount > 1) {
    console.error(`Info: Multi-account mode enabled with ${tokenCount} PAT tokens`);
    console.error('Info: Accounts will rotate on rate limit (429) or server errors (5xx)');
  } else if (tokenCount === 1) {
    console.error('Info: Single account mode (1 PAT token configured)');
  } else {
    console.error('Warning: No PAT tokens configured - using logged-in user');
    console.error('Tip: Set GITHUB_PAT_TOKENS=token1,token2,... for multi-account support');
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Graceful shutdown with SDK cleanup
  const shutdown = async () => {
    console.error('Shutting down...');
    taskManager.shutdown();
    await shutdownSDK();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
