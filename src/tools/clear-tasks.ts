import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { clientContext } from '../services/client-context.js';
import { deleteStorage, getStoragePath, hashCwd } from '../services/task-persistence.js';
import { mcpText, formatError } from '../utils/format.js';

const ClearTasksSchema = z.object({
  confirm: z.boolean().describe('Must be true to confirm deletion'),
});

export const clearTasksTool = {
  name: 'clear_tasks',
  description: `Delete all persisted tasks for current workspace. Requires confirm: true.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      confirm: {
        type: 'boolean',
        description: 'Must be true to confirm deletion.',
      },
    },
    required: ['confirm'],
  },
};

export async function handleClearTasks(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ClearTasksSchema.parse(args || {});

    if (!parsed.confirm) {
      return mcpText(formatError('Confirmation required', 'Call `clear_tasks` with `confirm: true` to proceed.'));
    }

    const cwd = clientContext.getDefaultCwd();

    // Clear in-memory tasks first
    const taskCount = taskManager.clearAllTasks();

    // Delete storage file
    const deleted = deleteStorage(cwd);

    const msg = deleted
      ? `Cleared ${taskCount} tasks for workspace.`
      : 'No tasks to clear (workspace already clean).';
    return mcpText(msg);
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Ensure `confirm` parameter is a boolean.'
    ));
  }
}
