#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  GetTaskRequestSchema, GetTaskPayloadRequestSchema, ListTasksRequestSchema, CancelTaskRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
  McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { launchSuperCoderTool, handleLaunchSuperCoder } from './tools/launch-super-coder.js';
import { launchSuperPlannerTool, handleLaunchSuperPlanner } from './tools/launch-super-planner.js';
import { launchSuperTesterTool, handleLaunchSuperTester } from './tools/launch-super-tester.js';
import { launchSuperResearcherTool, handleLaunchSuperResearcher } from './tools/launch-super-researcher.js';
import { launchClassicAgentTool, handleLaunchClassicAgent } from './tools/launch-classic-agent.js';
import { recoverFromSpawnFailure } from './tools/shared-spawn.js';
import { cancelAgentTool, handleCancelTask } from './tools/cancel-task.js';
import { messageAgentTool, handleSendMessage } from './tools/send-message.js';
import { answerAgentTool, handleAnswerQuestion } from './tools/answer-question.js';
import { taskManager } from './services/task-manager.js';
import { TERMINAL_STATUSES } from './types.js';
import { clientContext } from './services/client-context.js';
import { checkSDKAvailable, getSDKStats } from './services/sdk-spawner.js';
import { sdkClientManager } from './services/sdk-client-manager.js';
import { accountManager } from './services/account-manager.js';
import { buildMCPTask } from './services/task-status-mapper.js';
import { progressRegistry } from './services/progress-registry.js';
import { subscriptionRegistry, taskIdToUri, uriToTaskId } from './services/subscription-registry.js';
import { questionRegistry } from './services/question-registry.js';
import { processRegistry } from './services/process-registry.js';
import { mcpText, mcpValidationError } from './utils/format.js';
import { extractToolNameFromDetail } from './utils/tool-summarizer.js';
import { TaskStatus, isTerminalStatus } from './types.js';
import type { ToolContext, Provider } from './types.js';
import { createRequire } from 'module';
import { providerRegistry, parseChainString } from './providers/index.js';
import { setProviderChecker, canRunModel } from './models.js';
import { triggerFallback } from './providers/fallback-handler.js';
import { createTaskHandle } from './providers/task-handle-impl.js';
import { CopilotProviderAdapter } from './providers/copilot-adapter.js';
import { ClaudeProviderAdapter } from './providers/claude-adapter.js';
import { CodexProviderAdapter } from './providers/codex-adapter.js';
import { TASK_TIMEOUT_DEFAULT_MS } from './config/timeouts.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

const server = new Server(
  { name: 'mcp-supersubagents', version: PKG_VERSION },
  {
    capabilities: {
      tools: {},
      tasks: {
        list: {},
        cancel: {},
      },
      resources: {
        subscribe: true,
        listChanged: true,
      },
    },
  }
);

const BROKEN_PIPE_ERROR_CODES = new Set([
  'EPIPE',
  'EIO',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

function extractErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const maybeCode = (value as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function extractErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : String(value);
}

function isBrokenPipeLikeError(value: unknown): boolean {
  const normalizedCode = extractErrorCode(value)?.toUpperCase();
  if (normalizedCode && BROKEN_PIPE_ERROR_CODES.has(normalizedCode)) return true;

  const message = extractErrorMessage(value).toLowerCase();
  return (
    message.includes('epipe') ||
    message.includes('eio') ||
    message.includes('broken pipe') ||
    message.includes('stream destroyed') ||
    message.includes('write after end')
  );
}

let streamExitInProgress = false;
let shutdownHandler: ((signal?: string, exitCode?: number) => Promise<void>) | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;
let recentExceptionCount = 0;
let inStatusChangeCallback = false;
const BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 15_000;
})();

function exitOnBrokenPipe(source: string, value: unknown): void {
  if (streamExitInProgress || !isBrokenPipeLikeError(value)) return;
  streamExitInProgress = true;

  try {
    console.error(`[index] ${source}: detected broken stdio pipe, exiting`);
  } catch {
    // Ignore write failures while exiting due to broken pipe.
  }

  if (shutdownHandler) {
    // Ensure we never hang indefinitely during cleanup on a broken transport.
    const forceExitTimer = setTimeout(() => process.exit(0), BROKEN_PIPE_FORCE_EXIT_TIMEOUT_MS);
    forceExitTimer.unref();

    shutdownHandler(`broken_pipe:${source}`, 0)
      .catch(() => process.exit(0));
    return;
  }

  process.exit(0);
}

function installStdIoSafetyGuards(): void {
  process.stdout.on('error', (err) => exitOnBrokenPipe('stdout', err));
  process.stderr.on('error', (err) => exitOnBrokenPipe('stderr', err));
}

// Register retry callback for rate-limited tasks — routes through provider registry
taskManager.onRetry(async (task) => {
  console.error(`[index] Retrying task ${task.id}: "${task.prompt.slice(0, 50)}..."`);

  const provider = providerRegistry.getProvider(task.provider ?? 'copilot');
  if (!provider) {
    console.error(`[index] No provider '${task.provider}' for retry of task ${task.id}`);
    return undefined;
  }

  try {
    // Create a new task with the same parameters, carrying forward retry info
    const newTask = taskManager.createTask(task.prompt, task.cwd || process.cwd(), task.model || 'claude-sonnet-4.6', {
      provider: provider.id,
      timeout: task.timeout ?? TASK_TIMEOUT_DEFAULT_MS,
      labels: task.labels,
      retryInfo: task.retryInfo ? { ...task.retryInfo } : undefined,
      fallbackCount: task.fallbackCount,
      switchAttempted: task.switchAttempted,
      taskType: task.taskType,
    });

    // Spawn via the provider asynchronously
    setImmediate(() => {
      const handle = createTaskHandle(newTask.id);
      provider.spawn({
        taskId: newTask.id,
        prompt: task.prompt,
        cwd: task.cwd || process.cwd(),
        model: task.model || 'claude-sonnet-4.6',
        timeout: task.timeout ?? TASK_TIMEOUT_DEFAULT_MS,
      }, handle).catch((err) => {
        console.error(`[index] Retry spawn failed for ${newTask.id}:`, err);
        recoverFromSpawnFailure({
          taskId: newTask.id,
          failedProviderId: provider.id,
          reason: `${provider.id}_retry_spawn_error`,
          err,
          cwd: task.cwd || process.cwd(),
          promptOverride: task.prompt,
        });
      });
    });

    return newTask.id;
  } catch (err) {
    console.error(`[index] Failed to retry task ${task.id}:`, err);
    return undefined;
  }
});

// Register execute callback for waiting tasks (dependencies satisfied) — routes through provider
taskManager.onExecute(async (task) => {
  const provider = providerRegistry.getProvider(task.provider ?? 'copilot');
  try {
    if (!provider) {
      console.error(`[index] No provider '${task.provider}' for execute of task ${task.id}`);
      taskManager.updateTask(task.id, {
        status: TaskStatus.FAILED,
        error: `Provider '${task.provider ?? 'copilot'}' not available`,
        endTime: new Date().toISOString(),
        exitCode: 1,
      });
      return;
    }

    console.error(`[index] Executing waiting task ${task.id}: "${task.prompt.slice(0, 50)}..."`);
    const handle = createTaskHandle(task.id);
    await provider.spawn({
      taskId: task.id,
      prompt: task.prompt,
      cwd: task.cwd || process.cwd(),
      model: task.model || 'claude-sonnet-4.6',
      timeout: task.timeout ?? TASK_TIMEOUT_DEFAULT_MS,
    }, handle);
  } catch (err) {
    console.error(`[mcp-server] Execute failed for ${task.id}:`, err);
    const provId = (provider?.id ?? task.provider ?? 'copilot') as Provider;
    await recoverFromSpawnFailure({
      taskId: task.id,
      failedProviderId: provId,
      reason: `${provId}_execute_error`,
      err,
      cwd: task.cwd || process.cwd(),
      promptOverride: task.prompt,
    });
  }
});

// --- Progress & Resource notification wiring ---

const resourceUpdateTimers = new Map<string, NodeJS.Timeout>();
const statusUpdateTimers = new Map<string, NodeJS.Timeout>();

const logNotifyError = process.env.DEBUG_NOTIFICATIONS
  ? (e: unknown) => console.error('[notify]', e instanceof Error ? e.message : e)
  : () => {};

// Single onOutput registration: forwards to progress + debounced resource updates
taskManager.onOutput((taskId, line) => {
  // 1. Forward to progress registry (if client registered a progressToken)
  progressRegistry.sendProgress(taskId, line);

  // 2. Debounced resource updated notification (max 1/sec per task)
  const uri = taskIdToUri(taskId);
  const sessionUri = `${uri}/session`;
  if (!resourceUpdateTimers.has(taskId)) {
    const needsUpdate = subscriptionRegistry.isSubscribed(uri)
      || subscriptionRegistry.isSubscribed(sessionUri)
      || subscriptionRegistry.isSubscribed(TASK_ALL_URI);
    if (needsUpdate) {
      resourceUpdateTimers.set(taskId, setTimeout(() => {
        resourceUpdateTimers.delete(taskId);
        if (subscriptionRegistry.isSubscribed(uri)) {
          server.sendResourceUpdated({ uri }).catch(logNotifyError);
        }
        if (subscriptionRegistry.isSubscribed(sessionUri)) {
          server.sendResourceUpdated({ uri: sessionUri }).catch(logNotifyError);
        }
        if (subscriptionRegistry.isSubscribed(TASK_ALL_URI)) {
          server.sendResourceUpdated({ uri: TASK_ALL_URI }).catch(logNotifyError);
        }
      }, 1000).unref());
    }
  }
});

// Status changes: task notifications + progress + resource updates
taskManager.onStatusChange((task, previousStatus) => {
  if (inStatusChangeCallback) return;
  inStatusChangeCallback = true;
  try {
    // 1. MCP Task status notification
    const mcpTask = buildMCPTask(task);
    server.notification({
      method: 'notifications/tasks/status',
      params: { ...mcpTask },
    }).catch(logNotifyError);

    // 2. Track successful fallbacks (task completed after at least one fallback hop)
    if (task.status === TaskStatus.COMPLETED && (task.fallbackCount ?? 0) > 0) {
      providerRegistry.recordFallbackSuccess();
    }

    // 3. Progress notification for state transition
    progressRegistry.sendProgress(task.id, `Status: ${previousStatus} → ${task.status}`);

    // 3. Unregister progress on terminal states
    if (TERMINAL_STATUSES.has(task.status)) {
      progressRegistry.unregister(task.id);
    }

    // 4. Debounced resource updated notification (max 1/sec per task, same pattern as onOutput)
    const uri = taskIdToUri(task.id);
    const sessionUri = `${uri}/session`;
    if (!statusUpdateTimers.has(task.id)) {
      const needsUpdate = subscriptionRegistry.isSubscribed(uri)
        || subscriptionRegistry.isSubscribed(sessionUri)
        || subscriptionRegistry.isSubscribed(TASK_ALL_URI)
        || subscriptionRegistry.isSubscribed(SYSTEM_STATUS_URI);
      if (needsUpdate) {
        statusUpdateTimers.set(task.id, setTimeout(() => {
          statusUpdateTimers.delete(task.id);
          if (subscriptionRegistry.isSubscribed(uri)) {
            server.sendResourceUpdated({ uri }).catch(logNotifyError);
          }
          if (subscriptionRegistry.isSubscribed(sessionUri)) {
            server.sendResourceUpdated({ uri: sessionUri }).catch(logNotifyError);
          }
          if (subscriptionRegistry.isSubscribed(TASK_ALL_URI)) {
            server.sendResourceUpdated({ uri: TASK_ALL_URI }).catch(logNotifyError);
          }
          if (subscriptionRegistry.isSubscribed(SYSTEM_STATUS_URI)) {
            server.sendResourceUpdated({ uri: SYSTEM_STATUS_URI }).catch(logNotifyError);
          }
        }, 1000).unref());
      }
    }
  } finally {
    inStatusChangeCallback = false;
  }
});

// Task created: resource list changed
taskManager.onTaskCreated(() => {
  server.sendResourceListChanged().catch(logNotifyError);
});

// Task deleted: cleanup subscription + resource list changed
taskManager.onTaskDeleted((taskId) => {
  progressRegistry.unregister(taskId);
  subscriptionRegistry.unsubscribe(taskIdToUri(taskId));
  const resTimer = resourceUpdateTimers.get(taskId);
  if (resTimer) { clearTimeout(resTimer); resourceUpdateTimers.delete(taskId); }
  const statTimer = statusUpdateTimers.get(taskId);
  if (statTimer) { clearTimeout(statTimer); statusUpdateTimers.delete(taskId); }
  server.sendResourceListChanged().catch(logNotifyError);
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
  await taskManager.setCwd(cwd);
  
  console.error(`[index] MCP initialized - accounts: ${accountManager.getTokenCount()}, cwd: ${cwd}`);
};

// --- Tool handlers ---

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}

// 8 tools: 5 launch-* + message-agent + cancel-agent + answer-agent
const tools: McpToolDefinition[] = [
  launchSuperCoderTool,
  launchSuperPlannerTool,
  launchSuperTesterTool,
  launchSuperResearcherTool,
  launchClassicAgentTool,
  messageAgentTool,
  cancelAgentTool,
  answerAgentTool,
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
    ...(t.execution ? { execution: t.execution } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (isShuttingDown) return mcpValidationError('Server is shutting down — request rejected');
  try {
    const { name, arguments: args } = request.params;
    const ctx: ToolContext = {
      progressToken: extra._meta?.progressToken,
      sendNotification: extra.sendNotification,
    };

    switch (name) {
      case 'launch-super-coder': return handleLaunchSuperCoder(args, ctx);
      case 'launch-super-planner': return handleLaunchSuperPlanner(args, ctx);
      case 'launch-super-tester': return handleLaunchSuperTester(args, ctx);
      case 'launch-super-researcher': return handleLaunchSuperResearcher(args, ctx);
      case 'launch-classic-agent': return handleLaunchClassicAgent(args, ctx);
      case 'message-agent': return handleSendMessage(args, ctx);
      case 'cancel-agent': return handleCancelTask(args);
      case 'answer-agent': return handleAnswerQuestion(args);
      default: return mcpValidationError(`Unknown tool \`${name}\`. Available: launch-super-coder, launch-super-planner, launch-super-tester, launch-super-researcher, launch-classic-agent, message-agent, cancel-agent, answer-agent.`);
    }
  } catch (err) {
    return mcpValidationError(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
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
  if (Number.isNaN(startIndex) || startIndex < 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${request.params?.cursor}`);
  }
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
  const result = await taskManager.cancelTask(taskId);
  if (!result.success) {
    throw new McpError(ErrorCode.InvalidParams, result.error || 'Cannot cancel task');
  }
  const updatedTask = taskManager.getTask(taskId);
  if (!updatedTask) throw new McpError(ErrorCode.InvalidParams, 'Task was removed during cancel');
  return buildMCPTask(updatedTask);
});

// tasks/result — return filtered output as CallToolResult-compatible payload
const MAX_RESULT_LINES = 500;
const MAX_RESULT_BYTES = 100_000; // 100KB

server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
  const { taskId } = request.params;
  const task = taskManager.getTask(taskId);
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }
  if (!TERMINAL_STATUSES.has(task.status)) {
    throw new McpError(ErrorCode.InvalidParams, `Task ${taskId} is still ${task.status}`);
  }
  let filtered = filterOutputForResource(task.output);
  const totalLines = filtered.length;
  if (filtered.length > MAX_RESULT_LINES) {
    filtered = filtered.slice(-MAX_RESULT_LINES);
  }
  let text = filtered.join('\n');
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    const buf = Buffer.from(text);
    text = buf.subarray(-MAX_RESULT_BYTES).toString('utf8');
  }
  if (totalLines > MAX_RESULT_LINES) {
    text = `[truncated: showing last ${MAX_RESULT_LINES} of ${totalLines} lines]\n${text}`;
  }
  return {
    content: [{ type: 'text' as const, text }],
    isError: task.status !== TaskStatus.COMPLETED && task.status !== TaskStatus.CANCELLED,
  };
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
    {
      uriTemplate: SYSTEM_STATUS_URI,
      name: 'System Status',
      description: 'Account stats, SDK health, active task counts, and rate limit status.',
      mimeType: 'application/json',
    },
  ],
}));

// Noise line prefixes that callers don't need (verbose debug → file only)
const NOISE_PREFIXES = [
  '[reasoning]', '[usage]', '[quota]', '[hooks]', '[session]',
];

/**
 * Filter output lines for MCP resource consumers.
 * Keeps agent text + significant tool activity. Strips internal metadata.
 */
function filterOutputForResource(output: string[]): string[] {
  return output.filter(line => {
    for (const prefix of NOISE_PREFIXES) {
      if (line.startsWith(prefix)) return false;
    }
    // Drop redundant turn-ended / message-complete markers (kept in file)
    if (line.startsWith('[assistant] Turn ended') || line.startsWith('[assistant] Message complete')) return false;
    return true;
  });
}

// Helper: Parse output to execution log entries
function parseOutputToExecutionLog(output: string[]) {
  const entries: Array<{ turn: number; tools: Array<{ name: string; duration?: string; detail?: string }> }> = [];
  let currentTurn = 0;
  let currentEntry: typeof entries[number] | null = null;

  for (const line of output) {
    // New format: "--- Turn N ---"
    if (line.startsWith('--- Turn ')) {
      if (currentEntry) entries.push(currentEntry);
      currentTurn++;
      currentEntry = { turn: currentTurn, tools: [] };
      continue;
    }
    // Legacy format
    if (line.includes('[assistant] Message complete') || line.includes('[turn]')) {
      if (currentEntry) entries.push(currentEntry);
      currentTurn++;
      currentEntry = { turn: currentTurn, tools: [] };
      continue;
    }

    // Failed tool: "[tool] Failed: ToolName - error" or "[tool] Failed: ToolName — error"
    if (line.startsWith('[tool] Failed:') && currentEntry) {
      const match = line.match(/^\[tool\] Failed: (\S+)/);
      if (match) {
        currentEntry.tools.push({ name: match[1], detail: 'failed' });
      }
      continue;
    }

    // Compressed format: "[tool] <detail> (Nms)" or "[tool] <detail> (N.Ns)"
    // Matches both "read …/file.ts:1-50 (2.2s)" and "Read (450ms)"
    const compressedMatch = line.match(/^\[tool\] (.+) \((\d+(?:\.\d+)?(?:ms|s))\)$/);
    if (compressedMatch && currentEntry) {
      const detail = compressedMatch[1];
      const duration = compressedMatch[2];
      const name = extractToolNameFromDetail(detail);
      currentEntry.tools.push({ name, duration, detail });
      continue;
    }

    // Legacy: "[tool] Starting: ToolName"
    if (line.includes('[tool] Starting:')) {
      const match = line.match(/\[tool\] Starting: (\S+)/);
      if (match && currentEntry) {
        currentEntry.tools.push({ name: match[1] });
      }
      continue;
    }

    // Legacy: "[tool] Completed: ToolName (Nms)"
    if (line.includes('[tool] Completed:')) {
      const match = line.match(/\[tool\] Completed: (\S+) \((\d+)ms\)/);
      if (match && currentEntry && currentEntry.tools.length > 0) {
        const lastTool = currentEntry.tools[currentEntry.tools.length - 1];
        if (lastTool) lastTool.duration = `${match[2]}ms`;
      }
      continue;
    }
  }
  if (currentEntry) entries.push(currentEntry);
  return entries;
}

// Helper: Extract message stats from output for progress tracking
function extractMessageStats(output: string[]): { 
  round: number; 
  lastUserMessage?: string;
  totalMessages: number;
} {
  let round = 0;
  let lastUserMessage: string | undefined;
  let totalMessages = 0;
  
  for (const line of output) {
    // Count rounds/turns (new format: "--- Turn N ---", legacy: Message complete / [turn])
    if (line.startsWith('--- Turn ') || line.includes('[assistant] Message complete') || line.includes('[turn]')) {
      round++;
      totalMessages++;
    }
    // Track user messages (prompts sent to session)
    if (line.includes('[user]') || line.includes('[prompt]') || line.includes('Sending prompt:')) {
      const msgMatch = line.match(/(?:\[user\]|\[prompt\]|Sending prompt:)\s*(.+)/);
      if (msgMatch) {
        lastUserMessage = msgMatch[1].slice(0, 100) + (msgMatch[1].length > 100 ? '...' : '');
        totalMessages++;
      }
    }
    // Also count tool calls as messages
    if (line.includes('[tool] Starting:')) {
      totalMessages++;
    }
  }
  
  return { round, lastUserMessage, totalMessages };
}

// Helper: Check if task can receive messages
function canSendMessage(task: { status: TaskStatus; sessionId?: string }): boolean {
  const allowedStatuses = [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.RATE_LIMITED, TaskStatus.TIMED_OUT, TaskStatus.CANCELLED];
  return !!(task.sessionId && allowedStatuses.includes(task.status));
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
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
          waiting_answer: allTasks.filter(t => t.status === TaskStatus.WAITING_ANSWER).length,
          pending: allTasks.filter(t => t.status === TaskStatus.PENDING).length,
          waiting: allTasks.filter(t => t.status === TaskStatus.WAITING).length,
        },
        with_pending_questions: allTasks.filter(t => t.pendingQuestion).map(t => t.id),
      },
      sdk: sdkStats,
      providers: providerRegistry.getAllStats(),
    };
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data),
      }],
    };
  }
  
  // Handle task:///all - compact markdown table
  if (uri === TASK_ALL_URI) {
    const allTasks = taskManager.getAllTasks();
    const activeCount = allTasks.filter(t => !isTerminalStatus(t.status)).length;
    const lines: string[] = [];

    lines.push(`# Tasks (${activeCount} active, ${allTasks.length} total)`);
    lines.push('');

    if (allTasks.length === 0) {
      lines.push('No tasks yet. Use a `launch-*` tool to create one.');
    } else {
      lines.push('| ID | Status | Prompt | Lines | Last Activity |');
      lines.push('|---|---|---|---|---|');
      for (const task of allTasks) {
        const prompt = (task.prompt || '').replace(/\n/g, ' ').slice(0, 30);
        const promptCell = prompt.length >= 30 ? prompt + '…' : prompt;
        const outputLines = task.output?.length ?? 0;
        const lastActivity = formatRelativeTime(task.lastOutputAt || task.endTime || task.startTime);

        // Build descriptive status cell
        let statusCell: string = task.status;
        if (task.status === TaskStatus.WAITING && task.dependsOn?.length) {
          statusCell = `waiting → ${task.dependsOn.join(', ')}`;
        } else if (task.status === TaskStatus.WAITING_ANSWER) {
          statusCell = 'waiting_answer ⏸';
        } else if (task.status === TaskStatus.RATE_LIMITED && task.retryInfo) {
          statusCell = `rate_limited (retry ${task.retryInfo.retryCount}/${task.retryInfo.maxRetries})`;
        }

        lines.push(`| ${task.id} | ${statusCell} | ${promptCell} | ${outputLines} | ${lastActivity} |`);
      }
      lines.push('');
      lines.push('> Details: `task:///{id}` · Full logs: `cat -n <output_file>` · Poll: read `task:///all` every 30s to track progress');
    }

    // Pending questions section
    const tasksWithQuestions = allTasks.filter(t => t.pendingQuestion);
    if (tasksWithQuestions.length > 0) {
      lines.push('');
      lines.push(`## Pending Questions (${tasksWithQuestions.length})`);
      lines.push('');
      for (const task of tasksWithQuestions) {
        const pq = task.pendingQuestion!;
        lines.push(`### ${task.id}`);
        lines.push('');
        lines.push(`**Q:** ${pq.question}`);
        if (pq.choices?.length) {
          for (let i = 0; i < pq.choices.length; i++) {
            lines.push(`  ${i + 1}. ${pq.choices[i]}`);
          }
        }
        lines.push('');
        lines.push(`Answer: \`answer-agent { "task_id": "${task.id}", "answer": "1" }\``);
        lines.push('');
      }
    }

    return {
      contents: [{
        uri,
        mimeType: 'text/markdown',
        text: lines.join('\n'),
      }],
    };
  }
  
  // Handle task:///{id}/session - replaces get_task_session_detail
  if (uri.startsWith('task:///') && uri.endsWith('/session')) {
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
        text: JSON.stringify(data),
      }],
    };
  }
  
  // Handle task:///{id} - compact markdown detail
  const taskId = uriToTaskId(uri);
  if (!taskId) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid resource URI: ${uri}`);
  }
  const task = taskManager.getTask(taskId);
  if (!task) {
    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
  }

  const msgStats = extractMessageStats(task.output);
  const filtered = filterOutputForResource(task.output);
  const md: string[] = [];

  md.push(`# ${task.id}`);
  md.push('');

  // Compact status table — essentials only
  const turns = task.sessionMetrics?.turnCount ?? msgStats.round;
  const totalTokens = task.sessionMetrics
    ? (task.sessionMetrics.totalTokens?.input || 0) + (task.sessionMetrics.totalTokens?.output || 0)
    : undefined;
  md.push('| Field | Value |');
  md.push('|---|---|');
  // Descriptive status — same logic as task:///all
  let detailStatus = task.status as string;
  if (task.status === TaskStatus.WAITING && task.dependsOn?.length) {
    detailStatus = `waiting → ${task.dependsOn.join(', ')}`;
  } else if (task.status === TaskStatus.WAITING_ANSWER) {
    detailStatus = 'waiting_answer ⏸';
  }
  md.push(`| Status | ${detailStatus} |`);
  md.push(`| Model | ${task.model || '—'} |`);
  md.push(`| Turns | ${turns} |`);
  md.push(`| Output lines | ${task.output.length} |`);
  if (totalTokens) md.push(`| Tokens | ${totalTokens.toLocaleString()} |`);
  md.push(`| Started | ${formatRelativeTime(task.startTime)} |`);
  if (task.endTime) md.push(`| Ended | ${formatRelativeTime(task.endTime)} |`);
  if (task.error) md.push(`| Error | ${task.error.slice(0, 120)} |`);
  if (task.exitCode !== undefined && task.exitCode !== null) md.push(`| Exit code | ${task.exitCode} |`);
  if (canSendMessage(task)) md.push(`| Resumable | yes — use \`message-agent\` |`);

  // Pending question — compact
  if (task.pendingQuestion) {
    md.push('');
    md.push('## Pending Question');
    md.push('');
    md.push(`**Q:** ${task.pendingQuestion.question}`);
    if (task.pendingQuestion.choices?.length) {
      for (let i = 0; i < task.pendingQuestion.choices.length; i++) {
        md.push(`  ${i + 1}. ${task.pendingQuestion.choices[i]}`);
      }
    }
    md.push('');
    md.push(`Answer: \`answer-agent { "task_id": "${task.id}", "answer": "1" }\``);
  }

  // Rate limit info
  if (task.retryInfo) {
    md.push('');
    md.push(`**Rate limited:** retry ${task.retryInfo.retryCount}/${task.retryInfo.maxRetries} — ${task.retryInfo.reason || 'unknown'}`);
    if (task.retryInfo.nextRetryTime) md.push(`Next retry: ${formatRelativeTime(task.retryInfo.nextRetryTime)}`);
  }

  // Metrics — single line
  if (task.completionMetrics) {
    const cm = task.completionMetrics;
    md.push('');
    md.push(`**Metrics:** ${cm.totalApiCalls} API calls · +${cm.codeChanges.linesAdded}/-${cm.codeChanges.linesRemoved} lines · ${cm.codeChanges.filesModified.length} files`);
  }

  // Output tail — 20 lines, filtered to actionable prefixes only
  const actionable = filtered.filter(l =>
    l.startsWith('[tool]') || l.startsWith('[file]') || l.startsWith('[error]') ||
    l.startsWith('[question]') || l.startsWith('--- Turn') || l.startsWith('[assistant]')
  );
  const tail = actionable.slice(-20);
  if (tail.length > 0) {
    md.push('');
    md.push('## Recent Activity');
    md.push('');
    md.push('```');
    for (const line of tail) md.push(line);
    md.push('```');
  }

  // Output file pointer
  const outputPath = task.outputFilePath || `{cwd}/.super-agents/${task.id}.output`;
  md.push('');
  md.push(`> Full logs: \`cat -n ${outputPath}\``);

  return {
    contents: [{
      uri,
      mimeType: 'text/markdown',
      text: md.join('\n'),
    }],
  };
  } catch (err) {
    throw new McpError(ErrorCode.InternalError, `Resource error: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // Send standard MCP task status notification with input_required
  const task = taskManager.getTask(taskId);
  if (task) {
    const mcpTask = buildMCPTask(task);
    server.notification({
      method: 'notifications/tasks/status',
      params: { ...mcpTask },
    }).catch((err) => {
      console.error(`[index] Failed to send question notification for task ${taskId}:`, err);
    });
  }

  // Also send progress notification for clients that support progress but not task status
  progressRegistry.sendProgress(taskId, `⏸️ QUESTION: ${question.question}`);

  // Send resource update for subscribed clients
  const uri = taskIdToUri(taskId);
  const sessionUri = `${uri}/session`;
  if (subscriptionRegistry.isSubscribed(uri)) {
    server.sendResourceUpdated({ uri }).catch(logNotifyError);
  }
  if (subscriptionRegistry.isSubscribed(sessionUri)) {
    server.sendResourceUpdated({ uri: sessionUri }).catch(logNotifyError);
  }
  if (subscriptionRegistry.isSubscribed(TASK_ALL_URI)) {
    server.sendResourceUpdated({ uri: TASK_ALL_URI }).catch(logNotifyError);
  }
  if (subscriptionRegistry.isSubscribed(SYSTEM_STATUS_URI)) {
    server.sendResourceUpdated({ uri: SYSTEM_STATUS_URI }).catch(logNotifyError);
  }
});

// --- Start server ---

async function main() {
  // Initialize account manager early to read PAT tokens from env
  accountManager.initialize();
  
  // Register providers and configure chain
  providerRegistry.register(new CopilotProviderAdapter());
  providerRegistry.register(new CodexProviderAdapter());
  providerRegistry.register(new ClaudeProviderAdapter());

  const chainStr = process.env.PROVIDER_CHAIN || 'codex,copilot,!claude-cli';
  const chain = parseChainString(chainStr);
  providerRegistry.configureChain(chain);

  // Wire up dynamic model availability checker (dependency injection to avoid circular imports)
  setProviderChecker(() => ({
    ids: providerRegistry.getProviderIds(),
    canRun: (model: string, pid: string) => canRunModel(model, pid),
    isAvailable: (pid: string) => {
      const p = providerRegistry.getProvider(pid);
      return p ? p.checkAvailability().available : false;
    },
  }));

  const chainDisplay = chain.map((e, i) => {
    const label = e.fallbackOnly ? `!${e.id} (fallback-only)` : i === 0 ? `${e.id} (primary)` : e.id;
    return label;
  }).join(' → ');
  console.error(`[index] Provider chain: ${chainDisplay}`);

  // Startup availability diagnostic — shows which providers are actually ready
  for (const entry of chain) {
    const provider = providerRegistry.getProvider(entry.id);
    if (provider) {
      const avail = provider.checkAvailability();
      const status = avail.available ? '✓ available' : `✗ unavailable (${avail.reason})`;
      console.error(`[index] Provider '${entry.id}': ${status}`);
    }
  }
  
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
  
  // ============================================================================
  // Transport: STDIO only
  // ============================================================================

  installStdIoSafetyGuards();

  // Graceful shutdown with SDK cleanup (guard against double-shutdown)
  const shutdown = async (signal?: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const forceExitTimer = setTimeout(() => {
      try { console.error('[shutdown] Force exit — cleanup timed out after 30s'); } catch { /* stderr broken */ }
      process.exit(exitCode ?? 0);
    }, 30_000);
    forceExitTimer.unref();
    try { console.error(`Shutting down${signal ? ` (${signal})` : ''}...`); } catch { /* stderr broken */ }
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    for (const timer of resourceUpdateTimers.values()) {
      clearTimeout(timer);
    }
    resourceUpdateTimers.clear();
    for (const timer of statusUpdateTimers.values()) {
      clearTimeout(timer);
    }
    statusUpdateTimers.clear();
    try {
      // Shutdown all providers (replaces individual abortAllFallbackSessions + shutdownSDK)
      await providerRegistry.shutdownAll();
    } catch {}
    try {
      await taskManager.shutdown();
    } catch (err) {
      console.error('Shutdown error:', err);
    }
    try {
      questionRegistry.cleanup();
    } catch {}
    try {
      progressRegistry.clear();
    } catch {}
    try {
      subscriptionRegistry.clear();
    } catch {}
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  };
  shutdownHandler = shutdown;

  // STDIO transport (only supported mode)
  const transport = new StdioServerTransport();

  // Register stdin handlers BEFORE connect to avoid missing early disconnects
  const onStdioDisconnected = () => {
    shutdown('stdio_disconnected', 0).catch(() => process.exit(0));
  };
  process.stdin.once('end', onStdioDisconnected);
  process.stdin.once('close', onStdioDisconnected);

  await server.connect(transport);

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('exit', () => {
    processRegistry.killAllSync();
  });

  // Log unhandled errors but do NOT crash — crashing kills the MCP transport.
  // Task-level error handling already catches most issues; crashing here would
  // disconnect the client and lose all in-flight work.
  process.on('unhandledRejection', (reason) => {
    if (isBrokenPipeLikeError(reason)) {
      exitOnBrokenPipe('unhandledRejection', reason);
      return;
    }
    try {
      console.error('[WARN] Unhandled rejection (non-fatal):', reason);
    } catch {
      // If stderr itself is broken (e.g. revoked PTY), silently discard.
    }
  });

  let uncaughtExceptionInProgress = false;
  process.on('uncaughtException', (err) => {
    if (isBrokenPipeLikeError(err)) {
      exitOnBrokenPipe('uncaughtException', err);
      return;
    }

    // Rate-limit uncaught exceptions to prevent infinite loops
    if (++recentExceptionCount > 10) {
      try { console.error('[fatal] Too many uncaught exceptions — exiting'); } catch { /* stderr broken */ }
      process.exit(1);
    }
    setTimeout(() => { recentExceptionCount = Math.max(0, recentExceptionCount - 1); }, 5000).unref();

    // Guard against recursive uncaught-exception loops.
    if (uncaughtExceptionInProgress) {
      process.exit(1);
      return;
    }
    uncaughtExceptionInProgress = true;

    // Only crash on truly unrecoverable errors (e.g., out of memory)
    if (err.message?.includes('out of memory') || err.message?.includes('ENOMEM')) {
      console.error('[FATAL] Uncaught exception (unrecoverable):', err);
      shutdown('uncaughtException', 1).catch(() => process.exit(1));
    } else {
      try {
        console.error('[WARN] Uncaught exception (non-fatal):', err);
      } catch {
        // If stderr itself is broken (e.g. revoked PTY), silently discard.
      }
      uncaughtExceptionInProgress = false;
    }
  });

  // Periodic session leak detection + orphan resource sweep (every 5 min)
  monitorTimer = setInterval(() => {
    const stats = getSDKStats();
    if (stats.bindings > 0 || stats.sessions > 0) {
      console.error(
        `[session-monitor] Active: ${stats.bindings} bindings, ${stats.sessions} sessions, ${stats.clients} clients`
      );
    }

    // Sweep orphaned process entries where task is terminal
    let orphansFound = 0;
    for (const tracked of processRegistry.getAll()) {
      const task = taskManager.getTask(tracked.taskId);
      if (!task || isTerminalStatus(task.status)) {
        console.error(`[resource-sweep] Cleaning orphaned process entry for terminal task ${tracked.taskId}`);
        processRegistry.unregister(tracked.taskId);
        orphansFound++;
      }
    }
    if (orphansFound > 0) {
      console.error(`[resource-sweep] Cleaned ${orphansFound} orphaned process entries`);
    }
  }, 5 * 60_000);
  monitorTimer.unref();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
