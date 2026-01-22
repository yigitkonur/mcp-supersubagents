import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { clientContext } from '../services/client-context.js';
import { deleteStorage, getStoragePath, hashCwd } from '../services/task-persistence.js';

const ClearTasksSchema = z.object({
  confirm: z.boolean().describe('Must be true to confirm deletion'),
});

export const clearTasksTool = {
  name: 'clear_tasks',
  description: `Clear all persisted tasks for the current workspace.

**Use cases:**
- Clean up old tasks after testing
- Reset task history for a fresh start
- Free up disk space

**CAUTION:** This permanently deletes all task history for the current workspace.
Requires \`confirm: true\` to execute.

**Response includes:** success status, deleted file path, workspace hash`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      confirm: {
        type: 'boolean',
        description: 'Must be true to confirm deletion. Safety measure to prevent accidental data loss.',
      },
    },
    required: ['confirm'],
  },
};

export async function handleClearTasks(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ClearTasksSchema.parse(args || {});
    
    if (!parsed.confirm) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Confirmation required',
            message: 'Set confirm: true to delete all tasks for current workspace',
            suggested_action: 'clear_tasks',
            suggestion: 'Call clear_tasks with confirm: true to proceed',
          }),
        }],
      };
    }

    const cwd = clientContext.getDefaultCwd();
    const storagePath = getStoragePath(cwd);
    const cwdHash = hashCwd(cwd);
    
    // Clear in-memory tasks first
    const taskCount = taskManager.clearAllTasks();
    
    // Delete storage file
    const deleted = deleteStorage(cwd);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: deleted,
          cleared_tasks: taskCount,
          workspace: cwd,
          workspace_hash: cwdHash,
          storage_path: storagePath,
          message: deleted 
            ? `Cleared ${taskCount} tasks for workspace` 
            : 'No storage file found (already clean)',
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
          suggested_action: 'clear_tasks',
          suggestion: 'Ensure confirm parameter is a boolean',
        }),
      }],
    };
  }
}
