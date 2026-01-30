import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { mcpText, formatError, join } from '../utils/format.js';

const ForceStartSchema = z.object({
  task_id: z.string().min(1).describe('Task ID to force start'),
});

export const forceStartTool = {
  name: 'force_start',
  description: `Force start a waiting task, bypassing its dependencies.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Waiting task ID to force start.',
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
      const hint = result.error?.includes('not found')
        ? 'Use `list_tasks` to find valid task IDs.'
        : undefined;
      return mcpText(formatError(result.error || 'Unknown error', hint));
    }

    return mcpText(join(
      `Task **${result.taskId}** force-started, bypassing ${result.bypassedDeps?.length || 0} dependencies.`,
      'Check status with `get_status`.'
    ));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Ensure `task_id` is provided.'
    ));
  }
}
