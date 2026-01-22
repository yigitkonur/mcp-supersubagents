import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

const RetryTaskSchema = z.object({
  task_id: z.string().min(1).describe('Task ID to retry'),
});

export const retryTaskTool = {
  name: 'retry_task',
  description: `Manually trigger immediate retry of a rate-limited task.

**Use cases:**
- Skip the scheduled retry wait time
- Retry a task after you know rate limit has lifted
- Force retry of a task that's been waiting

**Requirements:**
- Task must be in \`rate_limited\` status
- Task must not have exceeded max retries

**Response includes:** success status, new_task_id (the retry task), original_task_id`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'The task ID to retry immediately',
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

    if (task.status !== TaskStatus.RATE_LIMITED) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Task is not rate-limited (status: ${task.status})`,
            task_id: task.id,
            current_status: task.status,
            suggestion: task.status === TaskStatus.FAILED 
              ? 'Task has already failed. Use spawn_task to create a new task with the same prompt.'
              : 'Only rate_limited tasks can be manually retried.',
          }),
        }],
      };
    }

    // Check if max retries exceeded
    if (task.retryInfo && task.retryInfo.retryCount >= task.retryInfo.maxRetries) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Max retries exceeded',
            task_id: task.id,
            retry_count: task.retryInfo.retryCount,
            max_retries: task.retryInfo.maxRetries,
            suggestion: 'Task has exceeded max retries. Use spawn_task to create a new task.',
          }),
        }],
      };
    }

    // Trigger the retry via TaskManager
    const result = await taskManager.triggerManualRetry(taskId);
    
    if (!result.success) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: result.error,
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
          original_task_id: task.id,
          new_task_id: result.newTaskId,
          retry_count: (task.retryInfo?.retryCount ?? 0) + 1,
          message: `Retry triggered. New task ${result.newTaskId} created.`,
          next_action: 'get_status',
          next_action_args: { task_id: result.newTaskId },
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
          suggested_action: 'retry_task',
          suggestion: 'Ensure task_id is provided',
        }),
      }],
    };
  }
}
