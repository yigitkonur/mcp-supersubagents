import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
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
  description: `Check task status. Returns status, output, session_id, exit_code, and retry hints.

**IMPORTANT - Avoid Excessive Polling:**
- For running/pending tasks, response includes "retry_after_seconds" and "retry_command"
- Backoff: 30s → 60s → 120s → 180s (then stays at 180s)
- Execute retry_command before next check (e.g., run_command with retry_command value)

**Supports batch checking:** Pass array of task_ids to check multiple tasks at once.

**Task IDs are case-insensitive** - "Brave-Tiger-42" equals "brave-tiger-42"`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        oneOf: [
          { type: 'string', description: 'Single task ID' },
          { type: 'array', items: { type: 'string' }, description: 'Array of task IDs to check' },
        ],
        description: 'Task ID(s) from spawn_task - can be a single ID or array of IDs',
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
}

// Track check counts per task for exponential backoff
const taskCheckCounts = new Map<string, number>();

function getTaskStatus(taskId: string): TaskStatusResult {
  const normalizedId = taskId.toLowerCase().trim();
  const task = taskManager.getTask(normalizedId);
  
  if (!task) {
    return { task_id: taskId, status: 'not_found', error: 'Task not found' };
  }

  // Increment check count for this task
  const checkCount = (taskCheckCounts.get(normalizedId) || 0) + 1;
  taskCheckCounts.set(normalizedId, checkCount);

  // Clean up check counts for completed tasks
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

  return result;
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
