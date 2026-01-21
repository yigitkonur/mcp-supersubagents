import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';

export const getTaskStatusTool = {
  name: 'get_task_status',
  description: 'Get the current status and output of a Copilot CLI task by its ID',
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID returned from spawn_copilot_task',
      },
    },
    required: ['taskId'],
  },
};

export async function handleGetTaskStatus(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = GetTaskStatusSchema.parse(args);
    
    const task = taskManager.getTask(parsed.taskId);
    
    if (!task) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Task not found: ${parsed.taskId}`,
            }, null, 2),
          },
        ],
      };
    }

    const output = task.output.join('\n');
    const outputTruncated = output.length > 50000 
      ? output.slice(-50000) + '\n... (output truncated, showing last 50000 chars)'
      : output;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            taskId: task.id,
            status: task.status,
            prompt: task.prompt,
            sessionId: task.sessionId,
            pid: task.pid,
            startTime: task.startTime,
            endTime: task.endTime,
            exitCode: task.exitCode,
            error: task.error,
            outputLines: task.output.length,
            output: outputTruncated,
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
