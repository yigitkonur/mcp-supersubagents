import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

const StreamOutputSchema = z.object({
  task_id: z.string().min(1),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const streamOutputTool = {
  name: 'stream_output',
  description: `Get incremental output from a task. Use offset to get new lines since last call. Efficient for streaming without re-fetching entire output.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to stream output from.',
      },
      offset: {
        type: 'number',
        description: 'Line offset to start from. Default: 0. Use next_offset from response.',
      },
      limit: {
        type: 'number',
        description: 'Max lines to return. Default: 100. Max: 500.',
      },
    },
    required: ['task_id'],
  },
};

export async function handleStreamOutput(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = StreamOutputSchema.parse(args || {});
    const taskId = parsed.task_id.toLowerCase().trim();
    
    const task = taskManager.getTask(taskId);
    
    if (!task) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Task not found',
            task_id: parsed.task_id,
            suggested_action: 'list_tasks',
          }),
        }],
      };
    }

    const totalLines = task.output.length;
    const offset = Math.min(parsed.offset, totalLines);
    const lines = task.output.slice(offset, offset + parsed.limit);
    const nextOffset = offset + lines.length;
    const hasMore = nextOffset < totalLines;
    
    const isTerminal = [
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.CANCELLED,
      TaskStatus.TIMED_OUT,
    ].includes(task.status);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          task_id: task.id,
          status: task.status,
          lines,
          offset,
          next_offset: nextOffset,
          total_lines: totalLines,
          has_more: hasMore,
          is_complete: isTerminal && !hasMore,
          ...(isTerminal && !hasMore ? { exit_code: task.exitCode } : {}),
          ...(task.error && isTerminal ? { error: task.error } : {}),
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      }],
    };
  }
}
