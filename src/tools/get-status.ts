import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager, isProcessAlive } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

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
    error: task.error,
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

export async function handleGetTaskStatus(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const rawTaskId = (args as any)?.task_id || (args as any)?.taskId;
    
    // Handle array of task IDs
    if (Array.isArray(rawTaskId)) {
      const results = rawTaskId.map(id => getTaskStatus(String(id)));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ tasks: results }),
        }],
      };
    }
    
    // Handle single task ID
    const result = getTaskStatus(String(rawTaskId));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
  }
}
