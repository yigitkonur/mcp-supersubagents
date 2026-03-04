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
import { questionRegistry } from '../services/question-registry.js';
import { clientContext } from '../services/client-context.js';
import { deleteStorage } from '../services/task-persistence.js';
import { mcpText, mcpError, displayStatus, formatTable } from '../utils/format.js';

const CancelTaskSchema = z.object({
  task_id: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1).max(50),
  ]).describe('Task ID, array of task IDs, or "all" to clear workspace'),
  clear: z.boolean().optional().describe('When task_id="all", set true to confirm and clear all tasks'),
});

export const cancelAgentTool = {
  name: 'cancel-agent',
  description: `Cancel running agents or clear the entire workspace.

**Cancel:** \`{ "task_id": "abc123" }\` or \`{ "task_id": ["abc", "def"] }\` (max 50).
**Clear all:** \`{ "task_id": "all", "clear": true }\` — kills active agents, removes all state.

Running agents are killed (SIGTERM → SIGKILL). Terminal agents are removed from memory.

**Find task_id:** Read \`task:///all\`.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: ['string', 'array'],
        minLength: 1,
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 50,
        description: 'Task ID, array of task IDs (max 50), or "all" to clear workspace.',
      },
      clear: {
        type: 'boolean',
        description: 'Required when task_id="all". Set true to confirm clearing all tasks.',
      },
    },
    required: ['task_id'],
  },
  annotations: {
    title: 'Cancel Agent',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

interface CancelResult {
  task_id: string;
  success: boolean;
  previous_status?: string;
  error?: string;
  outputFilePath?: string;
  already_dead?: boolean;
}

export async function handleCancelTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  try {
    const parsed = CancelTaskSchema.parse(args || {});
    
    // Handle "all" - clear workspace
    if (parsed.task_id === 'all') {
      if (!parsed.clear) {
        return mcpError(
          'Use clear=true to clear all tasks',
          '`{ "task_id": "all", "clear": true }`'
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
    const normalizedTaskIds = Array.isArray(parsed.task_id)
      ? parsed.task_id.map(id => id.toLowerCase().trim())
      : [parsed.task_id.toLowerCase().trim()];
    const taskIds = [...new Set(normalizedTaskIds)];
    
    // Process each task
    const results: CancelResult[] = await Promise.all(taskIds.map(async (taskId) => {
      const task = taskManager.getTask(taskId);
      
      if (!task) {
        return { task_id: taskId, success: false, error: 'Not found' };
      }
      
      const previousStatus = task.status;
      const outputFilePath = task.outputFilePath;
      
      // CC-011: Clear pending question directly on cancel
      questionRegistry.clearQuestion(taskId, 'task cancelled');
      
      const cancelResult = await taskManager.cancelTask(taskId);
      
      if (cancelResult.success) {
        return { 
          task_id: taskId, 
          success: true, 
          previous_status: previousStatus,
          outputFilePath,
          already_dead: cancelResult.alreadyDead,
        };
      } else {
        return { 
          task_id: taskId, 
          success: false, 
          previous_status: previousStatus,
          error: cancelResult.error || 'Cannot cancel',
        };
      }
    }));
    
    // Format response
    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    // Single task response
    if (taskIds.length === 1) {
      const result = results[0];
      if (result.success) {
        const parts: (string | null)[] = [
          result.already_dead ? `✅ **Task already finished**` : `✅ **Task cancelled**`,
          `task_id: \`${result.task_id}\``,
          `previous_status: ${displayStatus(result.previous_status!)}`,
          result.outputFilePath ? `output_file: \`${result.outputFilePath}\`` : null,
          '',
          result.outputFilePath ? `Review output: \`cat ${result.outputFilePath}\`` : null,
        ];
        return mcpText(parts.filter(Boolean).join('\n'));
      } else {
        return mcpError(
          `Failed to cancel **${result.task_id}**: ${result.error}`,
          'Only running/pending/waiting/rate-limited tasks can be cancelled. Check task:///all for status.'
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
