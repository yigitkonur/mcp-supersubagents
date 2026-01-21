import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';

export const getTaskStatusTool = {
  name: 'get_status',
  description: 'Poll task status and output. Returns: status, output, session_id, exit_code.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task ID from spawn_task' },
    },
    required: ['task_id'],
  },
};

export async function handleGetTaskStatus(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = GetTaskStatusSchema.parse({ taskId: (args as any)?.task_id || (args as any)?.taskId });
    const task = taskManager.getTask(parsed.taskId);
    
    if (!task) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Task not found' }) }] };
    }

    const output = task.output.join('\n');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          task_id: task.id,
          status: task.status,
          session_id: task.sessionId,
          exit_code: task.exitCode,
          output: output.length > 50000 ? output.slice(-50000) : output,
        }),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
  }
}
