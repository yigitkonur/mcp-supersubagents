import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

const ForceStartSchema = z.object({
  task_id: z.string().min(1).describe('Task ID to force start'),
});

export const forceStartTool = {
  name: 'force_start',
  description: `Force start a waiting task, bypassing failed or missing dependencies.

**Use cases:**
- A dependency failed but you want to proceed anyway
- A dependency was deleted/cleared but the task should still run
- You've manually resolved the issue the dependency was supposed to handle

**Requirements:**
- Task must be in \`waiting\` status
- Will clear dependency info and start execution immediately

**Response includes:** success status, task_id, bypassed_deps, new_status`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'The task ID to force start',
      },
    },
    required: ['task_id'],
  },
};

export async function handleForceStart(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ForceStartSchema.parse(args || {});
    const taskId = parsed.task_id.toLowerCase().trim();
    
    const result = await taskManager.forceStartTask(taskId);
    
    if (!result.success) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: result.error,
            task_id: parsed.task_id,
            suggested_action: result.error?.includes('not found') ? 'list_tasks' : 'get_status',
          }),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          task_id: result.taskId,
          bypassed_deps: result.bypassedDeps,
          new_status: 'pending',
          message: `Task ${result.taskId} force started, bypassing ${result.bypassedDeps?.length || 0} dependencies`,
          next_action: 'get_status',
          next_action_args: { task_id: result.taskId },
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
          suggested_action: 'force_start',
          suggestion: 'Ensure task_id is provided',
        }),
      }],
    };
  }
}
