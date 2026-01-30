import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import {
  mcpText, formatError, formatLabelsLine, formatLabels,
  formatDuration, formatOutputBlock, formatRetryHint,
  formatTable, displayStatus, join,
} from '../utils/format.js';

// Retry timing configuration (exponential backoff)
const RETRY_INTERVALS = [30, 60, 120, 180]; // seconds: 30s -> 1m -> 2m -> 3m (then stick with 3m)

function getRetryCommand(task: { status: TaskStatus }, waitSeconds: number): string | undefined {
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED) {
    return undefined;
  }

  return `sleep ${waitSeconds}`;
}

export const getTaskStatusTool = {
  name: 'get_status',
  description: `Check task status. Returns status, output, session_id, exit_code. Supports batch checking with array of task_ids. Includes retry_after_seconds for polling guidance. Task IDs are case-insensitive.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        oneOf: [
          { type: 'string', description: 'Single task ID' },
          { type: 'array', items: { type: 'string' }, description: 'Array of task IDs' },
        ],
        description: 'Task ID(s) to check.',
      },
    },
    required: ['task_id'],
  },
};

interface TaskStatusResult {
  task_id: string;
  status: string;
  session_id?: string;
  exit_code?: number;
  output?: string;
  error?: string;
  retry_after_seconds?: number;
  retry_command?: string;
  suggested_action?: string;
  retry_info?: {
    reason: string;
    retry_count: number;
    max_retries: number;
    next_retry_time: string;
    will_auto_retry: boolean;
  };
  dependency_info?: {
    depends_on: string[];
    satisfied: boolean;
    pending: string[];
    failed: string[];
    missing: string[];
  };
  timeout_info?: {
    timeout_ms: number;
    timeout_at: string;
    time_remaining_ms: number;
  };
  labels?: string[];
  provider?: string;
  fallback_attempted?: boolean;
}

// Track check counts per task for exponential backoff
const taskCheckCounts = new Map<string, number>();

function getTaskStatus(taskId: string): TaskStatusResult {
  const normalizedId = taskId.toLowerCase().trim();
  const task = taskManager.getTask(normalizedId);

  if (!task) {
    return {
      task_id: taskId,
      status: 'not_found',
      error: 'Task not found',
      suggested_action: 'list_tasks'
    };
  }

  // Increment check count for this task
  const checkCount = (taskCheckCounts.get(normalizedId) || 0) + 1;
  taskCheckCounts.set(normalizedId, checkCount);

  // Clean up check counts for terminal states
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED) {
    taskCheckCounts.delete(normalizedId);
  }

  const output = task.output.join('\n');
  const result: TaskStatusResult = {
    task_id: task.id,
    status: task.status,
    session_id: task.sessionId || undefined,
    exit_code: task.exitCode,
    output: output.length > 50000 ? output.slice(-50000) : output,
  };

  // Add retry command for non-terminal states
  if (task.status === TaskStatus.PENDING || task.status === TaskStatus.RUNNING) {
    const intervalIndex = Math.min(checkCount - 1, RETRY_INTERVALS.length - 1);
    const waitSeconds = RETRY_INTERVALS[intervalIndex];
    result.retry_after_seconds = waitSeconds;
    result.retry_command = getRetryCommand(task, waitSeconds);
  }

  // Add retry info for rate-limited tasks
  if (task.status === TaskStatus.RATE_LIMITED && task.retryInfo) {
    result.retry_info = {
      reason: task.retryInfo.reason,
      retry_count: task.retryInfo.retryCount,
      max_retries: task.retryInfo.maxRetries,
      next_retry_time: task.retryInfo.nextRetryTime,
      will_auto_retry: task.retryInfo.retryCount < task.retryInfo.maxRetries,
    };
    result.error = task.error;
  }

  // Add dependency info for tasks with dependencies
  if (task.dependsOn && task.dependsOn.length > 0) {
    const depStatus = taskManager.getDependencyStatus(task.id);
    result.dependency_info = {
      depends_on: task.dependsOn,
      satisfied: depStatus?.satisfied ?? false,
      pending: depStatus?.pending ?? [],
      failed: depStatus?.failed ?? [],
      missing: depStatus?.missing ?? [],
    };
  }

  // Add retry hints for waiting tasks
  if (task.status === TaskStatus.WAITING) {
    const intervalIndex = Math.min(checkCount - 1, RETRY_INTERVALS.length - 1);
    const waitSeconds = RETRY_INTERVALS[intervalIndex];
    result.retry_after_seconds = waitSeconds;
    result.retry_command = getRetryCommand(task, waitSeconds);
  }

  // Add timeout info for running tasks
  if (task.status === TaskStatus.RUNNING && task.timeout && task.timeoutAt) {
    const timeRemaining = new Date(task.timeoutAt).getTime() - Date.now();
    result.timeout_info = {
      timeout_ms: task.timeout,
      timeout_at: task.timeoutAt,
      time_remaining_ms: Math.max(0, timeRemaining),
    };
  }

  // Add labels if present
  if (task.labels && task.labels.length > 0) {
    result.labels = task.labels;
  }

  // Add provider info
  if (task.provider) {
    result.provider = task.provider;
  }
  if (task.fallbackAttempted) {
    result.fallback_attempted = true;
  }

  return result;
}

function formatSingleTaskStatus(result: TaskStatusResult): string {
  if (result.status === 'not_found') {
    return formatError('Task not found', 'Use `list_tasks` to find valid task IDs.');
  }

  const parts: string[] = [];

  // Headline: **task-id** -- status (provider)
  const statusStr = displayStatus(result.status);
  const providerStr = result.provider ? ` (${result.provider})` : '';
  const exitStr = result.exit_code !== undefined ? ` (exit code: ${result.exit_code})` : '';
  let headline = `**${result.task_id}** -- ${statusStr}${providerStr}${exitStr}`;
  if (result.fallback_attempted) headline += ' [fallback]';
  parts.push(headline);

  // Labels
  const labelsLine = formatLabelsLine(result.labels);
  if (labelsLine) parts.push(labelsLine);

  // Timeout info
  if (result.timeout_info) {
    parts.push(`Timeout: ${formatDuration(result.timeout_info.time_remaining_ms)} remaining`);
  }

  // Dependencies
  if (result.dependency_info) {
    const deps = result.dependency_info.depends_on.map(d => {
      if (result.dependency_info!.pending.includes(d)) return `\`${d}\` (pending)`;
      if (result.dependency_info!.failed.includes(d)) return `\`${d}\` (failed)`;
      if (result.dependency_info!.missing.includes(d)) return `\`${d}\` (missing)`;
      return `\`${d}\` (done)`;
    });
    parts.push(`Depends on: ${deps.join(', ')}`);
  }

  // Retry info (rate-limited)
  if (result.retry_info) {
    parts.push(`Retry ${result.retry_info.retry_count}/${result.retry_info.max_retries} -- next at ${result.retry_info.next_retry_time}`);
    parts.push(`Will auto-retry: ${result.retry_info.will_auto_retry ? 'yes' : 'no'}`);
  }

  // Error
  if (result.error) {
    parts.push('');
    parts.push(`**Error:** ${result.error}`);
  }

  // Output
  if (result.output && result.output.trim()) {
    parts.push('');
    const label = result.status === 'running' ? 'Latest output' : 'Output';
    parts.push(formatOutputBlock(result.output, label));
  }

  // Session hint for resume
  if (result.session_id && (result.status === 'completed' || result.status === 'failed')) {
    parts.push('');
    parts.push(`Session \`${result.session_id}\` available for \`resume_task\`.`);
  }

  // Retry hint
  const retryHint = formatRetryHint(result.retry_command);
  if (retryHint) {
    parts.push('');
    parts.push(retryHint);
  }

  // Rate-limited specific hint
  if (result.status === 'rate_limited') {
    parts.push('');
    parts.push('Use `retry_task` to retry manually.');
  }

  return parts.join('\n');
}

function formatBatchTaskStatus(results: TaskStatusResult[]): string {
  const parts: string[] = [];
  parts.push(`## Task Status (${results.length} tasks)`);
  parts.push('');

  const rows = results.map(r => {
    if (r.status === 'not_found') {
      return [`**${r.task_id}**`, 'not found', '--'];
    }
    let statusStr = displayStatus(r.status);
    if (r.provider) statusStr += ` (${r.provider})`;
    if (r.exit_code !== undefined && (r.status === 'completed' || r.status === 'failed')) {
      statusStr += ` (exit: ${r.exit_code})`;
    }
    if (r.dependency_info?.pending.length) {
      statusStr += ` -> ${r.dependency_info.pending.join(', ')}`;
    }
    if (r.fallback_attempted) statusStr += ' [fallback]';
    return [
      `**${r.task_id}**`,
      statusStr,
      formatLabels(r.labels) || '--',
    ];
  });

  parts.push(formatTable(['Task', 'Status', 'Labels'], rows));

  // Add retry hint if any non-terminal task exists
  const nonTerminalResults = results.filter(r =>
    !['completed', 'failed', 'cancelled', 'timed_out', 'not_found'].includes(r.status)
  );
  if (nonTerminalResults.length > 0) {
    const retrySeconds = nonTerminalResults
      .filter(r => r.retry_after_seconds)
      .map(r => r.retry_after_seconds!);
    const maxRetry = retrySeconds.length > 0 ? Math.max(...retrySeconds) : 30;
    parts.push('');
    parts.push(`Run \`sleep ${maxRetry}\` then check again.`);
  }

  return parts.join('\n');
}

export async function handleGetTaskStatus(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const rawTaskId = (args as any)?.task_id || (args as any)?.taskId;

    // Handle array of task IDs
    if (Array.isArray(rawTaskId)) {
      const results = rawTaskId.map(id => getTaskStatus(String(id)));
      return mcpText(formatBatchTaskStatus(results));
    }

    // Handle single task ID
    const result = getTaskStatus(String(rawTaskId));
    return mcpText(formatSingleTaskStatus(result));
  } catch (error) {
    return mcpText(formatError(error instanceof Error ? error.message : 'Unknown'));
  }
}
