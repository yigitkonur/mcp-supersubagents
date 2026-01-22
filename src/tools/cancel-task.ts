import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Task not found',
            task_id: parsed.task_id,
            suggested_action: 'list_tasks',
            suggestion: 'Use list_tasks to find valid task IDs',
          }),
        }],
      };
    }

    const previousStatus = task.status;
    
    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Task cannot be cancelled (status: ${task.status})`,
            task_id: task.id,
            current_status: task.status,
            suggestion: 'Only running or pending tasks can be cancelled.',
          }),
        }],
      };
    }

    const cancelled = taskManager.cancelTask(taskId);
    
    if (!cancelled) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Failed to cancel task',
            task_id: task.id,
          }),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          task_id: task.id,
          previous_status: previousStatus,
          new_status: 'cancelled',
          message: `Task ${task.id} cancelled successfully`,
          had_process: !!task.process,
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
          suggested_action: 'cancel_task',
          suggestion: 'Ensure task_id is provided',
        }),
      }],
    };
  }
}
