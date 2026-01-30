import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import { mcpText, formatError, displayStatus } from '../utils/format.js';

const CancelTaskSchema = z.object({
  task_id: z.string().min(1).describe('Task ID to cancel'),
});

export const cancelTaskTool = {
  name: 'cancel_task',
  description: `Cancel a running or pending task by killing its process (SIGTERM).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to cancel.',
      },
    },
    required: ['task_id'],
  },
};

export async function handleCancelTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = CancelTaskSchema.parse(args || {});
    const taskId = parsed.task_id.toLowerCase().trim();

    const task = taskManager.getTask(taskId);

    if (!task) {
      return mcpText(formatError('Task not found', 'Use `list_tasks` to find valid task IDs.'));
    }

    const previousStatus = task.status;

    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING) {
      return mcpText(formatError(
        `Cannot cancel task (status: ${displayStatus(task.status)})`,
        'Only `running` or `pending` tasks can be cancelled.'
      ));
    }

    const cancelled = taskManager.cancelTask(taskId);

    if (!cancelled) {
      return mcpText(formatError(`Failed to cancel task **${task.id}**`));
    }

    return mcpText(`Task **${task.id}** cancelled (was: ${displayStatus(previousStatus)}).`);
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Ensure `task_id` is provided.'
    ));
  }
}
