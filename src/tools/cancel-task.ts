/**
 * Cancel Task Tool - Cancel running tasks or clear all tasks.
 * 
 * Supports:
 * - Single task cancellation
 * - Batch cancellation (array of task IDs)
 * - Clear all tasks (task_id: "all" with clear: true)
 */

import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { clientContext } from '../services/client-context.js';
import { deleteStorage } from '../services/task-persistence.js';
import { mcpText, mcpError, displayStatus, formatTable } from '../utils/format.js';

const CancelTaskSchema = z.object({
  task_id: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1).max(50),
  ]).describe('Task ID, array of task IDs, or "all" to clear workspace'),
  clear: z.boolean().optional().describe('When task_id="all", set true to clear all tasks'),
  confirm: z.boolean().optional().describe('Required when clear=true'),
});

export const cancelTaskTool = {
  name: 'cancel_task',
  description: `Cancel or clear tasks. Accepts single ID, array of IDs, or "all" to clear workspace.

**Examples:**
- Cancel one: \`{ "task_id": "abc123" }\`
- Cancel many: \`{ "task_id": ["abc", "def", "ghi"] }\`
- Clear all: \`{ "task_id": "all", "clear": true, "confirm": true }\`

Running/pending tasks are killed (SIGTERM). Completed/failed tasks are removed from memory.
Use MCP Resources to check task status: read \`task:///all\` or \`task:///{id}\`.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        oneOf: [
          { type: 'string', description: 'Single task ID or "all"' },
          { type: 'array', items: { type: 'string' }, description: 'Array of task IDs to cancel' },
        ],
        description: 'Task ID(s) to cancel, or "all" to clear workspace.',
      },
      clear: {
        type: 'boolean',
        description: 'When task_id="all", set true to clear all tasks from workspace.',
      },
      confirm: {
        type: 'boolean',
        description: 'Required confirmation when clear=true.',
      },
    },
    required: ['task_id'],
  },
};

interface CancelResult {
  task_id: string;
  success: boolean;
  previous_status?: string;
  error?: string;
}

export async function handleCancelTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  try {
    const parsed = CancelTaskSchema.parse(args || {});
    
    // Handle "all" - clear workspace
    if (parsed.task_id === 'all') {
      if (!parsed.clear) {
        return mcpError(
          'Use clear=true to clear all tasks',
          '`{ "task_id": "all", "clear": true, "confirm": true }`'
        );
      }
      if (!parsed.confirm) {
        return mcpError(
          'Confirmation required',
          '`{ "task_id": "all", "clear": true, "confirm": true }`'
        );
      }
      
      const cwd = clientContext.getDefaultCwd();
      const taskCount = await taskManager.clearAllTasks();
      const deleted = await deleteStorage(cwd);
      
      return mcpText(deleted 
        ? `✅ Cleared **${taskCount}** tasks from workspace.`
        : 'No tasks to clear (workspace already clean).'
      );
    }
    
    // Normalize to array
    const taskIds = Array.isArray(parsed.task_id) 
      ? parsed.task_id.map(id => id.toLowerCase().trim())
      : [parsed.task_id.toLowerCase().trim()];
    
    // Process each task
    const results: CancelResult[] = [];
    
    for (const taskId of taskIds) {
      const task = taskManager.getTask(taskId);
      
      if (!task) {
        results.push({ task_id: taskId, success: false, error: 'Not found' });
        continue;
      }
      
      const previousStatus = task.status;
      const cancelResult = taskManager.cancelTask(taskId);
      
      if (cancelResult.success) {
        results.push({ 
          task_id: taskId, 
          success: true, 
          previous_status: previousStatus,
        });
      } else {
        results.push({ 
          task_id: taskId, 
          success: false, 
          previous_status: previousStatus,
          error: cancelResult.error || 'Cannot cancel',
        });
      }
    }
    
    // Format response
    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    // Single task response
    if (taskIds.length === 1) {
      const result = results[0];
      const task = taskManager.getTask(result.task_id);
      if (result.success) {
        const parts: (string | null)[] = [
          `✅ **Task cancelled**`,
          `task_id: \`${result.task_id}\``,
          `previous_status: ${displayStatus(result.previous_status!)}`,
          task?.outputFilePath ? `output_file: \`${task.outputFilePath}\`` : null,
          '',
          task?.outputFilePath ? `Review output: \`cat ${task.outputFilePath}\`` : null,
        ];
        return mcpText(parts.filter(Boolean).join('\n'));
      } else {
        return mcpError(
          `Failed to cancel **${result.task_id}**: ${result.error}`,
          'Only running/pending/waiting tasks can be cancelled. Check task:///all for status.'
        );
      }
    }
    
    // Batch response
    const parts: string[] = [];
    parts.push(`## Cancel Results (${succeeded.length}/${results.length} succeeded)`);
    parts.push('');
    
    if (succeeded.length > 0) {
      const rows = succeeded.map(r => [r.task_id, '✅', displayStatus(r.previous_status!)]);
      parts.push(formatTable(['Task', 'Result', 'Was'], rows));
    }
    
    if (failed.length > 0) {
      parts.push('');
      parts.push('### Failed');
      const rows = failed.map(r => [r.task_id, '❌', r.error || 'Unknown']);
      parts.push(formatTable(['Task', 'Result', 'Reason'], rows));
    }
    
    return mcpText(parts.join('\n'));
    
  } catch (error) {
    return mcpError(
      error instanceof Error ? error.message : 'Unknown error',
      'Provide task_id as string, array, or "all". Check task:///all for valid IDs.'
    );
  }
}
