import { ListTasksSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

export const listTasksTool = {
  name: 'list_tasks',
  description: 'List all Copilot CLI tasks, optionally filtered by status',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
        description: 'Filter tasks by status',
      },
    },
    required: [],
  },
};

export async function handleListTasks(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ListTasksSchema.parse(args || {});
    
    const statusFilter = parsed.status ? parsed.status as TaskStatus : undefined;
    const tasks = taskManager.getAllTasks(statusFilter);

    const summaries = tasks.map(task => ({
      id: task.id,
      status: task.status,
      prompt: task.prompt.length > 100 ? task.prompt.slice(0, 100) + '...' : task.prompt,
      startTime: task.startTime,
      endTime: task.endTime,
      exitCode: task.exitCode,
      sessionId: task.sessionId,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: summaries.length,
            tasks: summaries,
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: message,
          }, null, 2),
        },
      ],
    };
  }
}
