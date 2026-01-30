import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import { mcpText, formatError, join, displayStatus } from '../utils/format.js';

const RetryTaskSchema = z.object({
  task_id: z.string().min(1).describe('Task ID to retry'),
});

export const retryTaskTool = {
  name: 'retry_task',
  description: `Immediately retry a rate-limited task. Creates new task with same prompt.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Rate-limited task ID to retry.',
      },
    },
    required: ['task_id'],
  },
};

export async function handleRetryTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = RetryTaskSchema.parse(args || {});
    const taskId = parsed.task_id.toLowerCase().trim();

    const task = taskManager.getTask(taskId);

    if (!task) {
      return mcpText(formatError('Task not found', 'Use `list_tasks` to find valid task IDs.'));
    }

    if (task.status !== TaskStatus.RATE_LIMITED) {
      const hint = task.status === TaskStatus.FAILED
        ? 'Task has already failed. Use `spawn_task` to create a new task with the same prompt.'
        : 'Only `rate_limited` tasks can be retried with this tool.';
      return mcpText(formatError(
        `Task is not rate-limited (status: ${displayStatus(task.status)})`,
        hint
      ));
    }

    // Check if max retries exceeded
    if (task.retryInfo && task.retryInfo.retryCount >= task.retryInfo.maxRetries) {
      return mcpText(formatError(
        `Max retries exceeded (${task.retryInfo.retryCount}/${task.retryInfo.maxRetries})`,
        'Use `spawn_task` to create a new task with the same prompt.'
      ));
    }

    // Trigger the retry via TaskManager
    const result = await taskManager.triggerManualRetry(taskId);

    if (!result.success) {
      return mcpText(formatError(result.error || 'Retry failed'));
    }

    const attempt = (task.retryInfo?.retryCount ?? 0) + 1;
    return mcpText(join(
      `Retried **${task.id}** as **${result.newTaskId}** (attempt ${attempt}).`,
      'Check status with `get_status`.'
    ));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Ensure `task_id` is provided.'
    ));
  }
}
