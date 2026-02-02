import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager, isProcessAlive } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import {
  mcpText, formatError, formatLabelsLine, formatLabels,
  formatDuration, formatOutputBlock, formatRetryHint,
  formatTable, displayStatus, join,
} from '../utils/format.js';
import { TASK_STALL_WARN_MS } from '../config/timeouts.js';

// Retry timing configuration (exponential backoff)
const RETRY_INTERVALS = [30, 60, 120, 180]; // seconds: 30s -> 1m -> 2m -> 3m (then stick with 3m)

// Polling throttle: block agents that spam get_status too fast
const THROTTLE_WINDOW_MS = 30_000;  // 30-second sliding window
const THROTTLE_THRESHOLD = 3;        // 3 calls within window triggers throttle
const THROTTLE_SLEEP_MS  = 59_000;  // sleep 59 seconds when triggered
const callTimestamps: number[] = [];

async function applyThrottle(): Promise<string | null> {
  const now = Date.now();

  // Evict timestamps older than the window
  while (callTimestamps.length > 0 && callTimestamps[0] < now - THROTTLE_WINDOW_MS) {
    callTimestamps.shift();
  }

  // Record this call
  callTimestamps.push(now);

  // If threshold exceeded, sleep then return throttle message
  if (callTimestamps.length >= THROTTLE_THRESHOLD) {
    const sleepSeconds = Math.ceil(THROTTLE_SLEEP_MS / 1000);
    await new Promise(resolve => setTimeout(resolve, THROTTLE_SLEEP_MS));
    // Reset window after sleeping
    callTimestamps.length = 0;
    return [
      `**Throttled.** You called \`get_status\` ${THROTTLE_THRESHOLD}+ times in ${THROTTLE_WINDOW_MS / 1000}s.`,
      `Waited ${sleepSeconds}s before responding.`,
      '',
      `You MUST run \`sleep ${sleepSeconds}\` before calling \`get_status\` again.`,
      'Do not poll rapidly -- tasks take time to complete.',
    ].join('\n');
  }

  return null;
}

function getRetryCommand(task: { status: TaskStatus }, waitSeconds: number): string | undefined {
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED || task.status === TaskStatus.TIMED_OUT) {
    return undefined;
  }

  return `sleep ${waitSeconds}`;
}

export const getTaskStatusTool = {
  name: 'get_status',
  description: `Check task status. Returns status, output, session_id, exit_code. Supports batch checking with array of task_ids. Task IDs are case-insensitive.

IMPORTANT: Do NOT poll this rapidly. The response includes a \`sleep N\` command -- you MUST run it before calling get_status again. If you call get_status 3+ times within 30 seconds, the server will force a 59-second wait before responding. Always run the suggested sleep command between status checks. Tasks take time -- be patient.

To check multiple tasks at once, pass an array of task_ids instead of calling get_status repeatedly for each one.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        oneOf: [
          { type: 'string', description: 'Single task ID' },
          { type: 'array', items: { type: 'string' }, description: 'Array of task IDs -- use this to check multiple tasks in a single call instead of calling get_status multiple times' },
        ],
        description: 'Task ID(s) to check. Pass an array to check multiple tasks in one call.',
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
  timeout_reason?: string;
  timeout_context?: {
    timeout_ms?: number;
    timeout_at?: string;
    elapsed_ms?: number;
    last_output_at?: string;
    last_output_age_ms?: number;
    last_heartbeat_at?: string;
    pid_alive?: boolean;
    detected_by?: string;
  };
  last_output_age_ms?: number;
  last_heartbeat_age_ms?: number;
  labels?: string[];
  provider?: string;
  fallback_attempted?: boolean;
}

// Track check counts per task for exponential backoff
const taskCheckCounts = new Map<string, number>();

/**
 * Build TaskStatusResult from a task object
 */
function getTaskStatusFromTask(task: NonNullable<ReturnType<typeof taskManager.getTask>>, normalizedId: string): TaskStatusResult {
  // Increment check count for this task
  const checkCount = (taskCheckCounts.get(normalizedId) || 0) + 1;
  taskCheckCounts.set(normalizedId, checkCount);

  // Clean up check counts for terminal states
  if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED || task.status === TaskStatus.TIMED_OUT) {
    taskCheckCounts.delete(normalizedId);
  }

  const now = Date.now();
  const lastOutputAgeMs = task.lastOutputAt ? now - new Date(task.lastOutputAt).getTime() : undefined;
  const lastHeartbeatAgeMs = task.lastHeartbeatAt ? now - new Date(task.lastHeartbeatAt).getTime() : undefined;

  const output = task.output.join('\n');
  const result: TaskStatusResult = {
    task_id: task.id,
    status: task.status,
    session_id: task.sessionId || undefined,
    exit_code: task.exitCode,
    output: output.length > 50000 ? output.slice(-50000) : output,
    error: task.error,
    timeout_reason: task.timeoutReason,
    timeout_context: task.timeoutContext ? {
      timeout_ms: task.timeoutContext.timeoutMs,
      timeout_at: task.timeoutContext.timeoutAt,
      elapsed_ms: task.timeoutContext.elapsedMs,
      last_output_at: task.timeoutContext.lastOutputAt,
      last_output_age_ms: task.timeoutContext.lastOutputAgeMs,
      last_heartbeat_at: task.timeoutContext.lastHeartbeatAt,
      pid_alive: task.timeoutContext.pidAlive,
      detected_by: task.timeoutContext.detectedBy,
    } : undefined,
    last_output_age_ms: lastOutputAgeMs,
    last_heartbeat_age_ms: lastHeartbeatAgeMs,
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

  // Suggested actions
  if (task.status === TaskStatus.TIMED_OUT) {
    result.suggested_action = task.sessionId ? 'resume_task' : 'spawn_task';
  } else if (task.status === TaskStatus.RUNNING && lastOutputAgeMs !== undefined && lastOutputAgeMs >= TASK_STALL_WARN_MS) {
    result.suggested_action = 'stream_output';
  }

  return result;
}

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

  // Verify process liveness for RUNNING tasks
  if (task.status === TaskStatus.RUNNING && task.pid) {
    if (!isProcessAlive(task.pid)) {
      // Process died but status wasn't updated - mark as failed
      console.error(`[get-status] Detected dead process for task ${task.id} (pid=${task.pid})`);
      taskManager.updateTask(task.id, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: 'Process exited unexpectedly (detected via liveness check)',
        process: undefined,
        timeoutReason: 'process_dead',
        timeoutContext: {
          pidAlive: false,
          lastHeartbeatAt: task.lastHeartbeatAt,
          lastOutputAt: task.lastOutputAt,
          detectedBy: 'manual',
        },
      });
      // Re-fetch the updated task
      const updatedTask = taskManager.getTask(normalizedId);
      if (updatedTask) {
        return getTaskStatusFromTask(updatedTask, normalizedId);
      }
    }
  }

  return getTaskStatusFromTask(task, normalizedId);
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
  if (result.last_output_age_ms !== undefined) {
    parts.push(`Last output: ${formatDuration(result.last_output_age_ms)} ago`);
  }
  if (result.last_heartbeat_age_ms !== undefined && result.status === 'running') {
    parts.push(`Last heartbeat: ${formatDuration(result.last_heartbeat_age_ms)} ago`);
  }
  if (result.status === 'running' && result.last_output_age_ms !== undefined && result.last_output_age_ms >= TASK_STALL_WARN_MS) {
    parts.push('No output for a while — task may be stalled.');
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

  if (result.timeout_reason) {
    parts.push('');
    parts.push(`Timeout reason: ${displayStatus(result.timeout_reason)}`);
  }
  if (result.timeout_context?.last_output_age_ms !== undefined) {
    parts.push(`Last output before timeout: ${formatDuration(result.timeout_context.last_output_age_ms)} ago`);
  }

  if (result.status === 'timed_out') {
    parts.push('');
    switch (result.timeout_reason) {
      case 'stall':
        parts.push('Likely stalled (no output for a long time). Consider resuming or rerunning with a higher timeout.');
        break;
      case 'hard_timeout':
        parts.push('Hit the configured timeout. Consider resuming or rerunning with a higher timeout.');
        break;
      case 'server_restart':
        parts.push('Server restarted during execution. You can resume if a session is available.');
        break;
      case 'process_dead':
        parts.push('Process exited unexpectedly. Consider rerunning the task.');
        break;
      default:
        parts.push('Task timed out. Consider resuming or rerunning.');
        break;
    }
  }

  if (result.suggested_action) {
    parts.push(`Suggested action: \`${result.suggested_action}\``);
  }

  // Output
  if (result.output && result.output.trim()) {
    parts.push('');
    const label = result.status === 'running' ? 'Latest output' : 'Output';
    parts.push(formatOutputBlock(result.output, label));
  }

  // Session hint for resume
  if (result.session_id && (result.status === 'completed' || result.status === 'failed' || result.status === 'timed_out')) {
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
      return [`**${r.task_id}**`, 'not found', '--', '--', '--'];
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
    const reason = r.status === 'timed_out'
      ? displayStatus(r.timeout_reason || 'unknown')
      : '--';
    const nextAction = r.suggested_action ? `\`${r.suggested_action}\`` : '--';
    return [
      `**${r.task_id}**`,
      statusStr,
      reason,
      nextAction,
      formatLabels(r.labels) || '--',
    ];
  });

  parts.push(formatTable(['Task', 'Status', 'Reason', 'Next', 'Labels'], rows));

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

  const timedOutResults = results.filter(r => r.status === 'timed_out');
  if (timedOutResults.length > 0) {
    parts.push('');
    parts.push('### Timed out details');
    for (const r of timedOutResults) {
      const reason = displayStatus(r.timeout_reason || 'unknown');
      const action = r.suggested_action ? `Suggested action: \`${r.suggested_action}\`` : 'Suggested action: `spawn_task`';
      const lastOutputAge = r.timeout_context?.last_output_age_ms ?? r.last_output_age_ms;
      const lastOutputNote = lastOutputAge !== undefined ? `Last output: ${formatDuration(lastOutputAge)} ago` : undefined;
      const details = [action, lastOutputNote].filter(Boolean).join(' • ');
      parts.push(`- **${r.task_id}** — ${reason}. ${details}`);
    }
  }

  return parts.join('\n');
}


export async function handleGetTaskStatus(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Throttle rapid polling -- may sleep 59s and return early
  const throttleMsg = await applyThrottle();
  if (throttleMsg) {
    return mcpText(throttleMsg);
  }

  try {
    const input = args as any;
    const parsed = GetTaskStatusSchema.parse({
      taskId: input?.task_id ?? input?.taskId,
    });
    const rawTaskId = parsed.taskId;

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
