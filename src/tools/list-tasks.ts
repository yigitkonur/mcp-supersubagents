import { ListTasksSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import { mcpText, formatError, formatLabels, formatTable, displayStatus, join } from '../utils/format.js';

export const listTasksTool = {
  name: 'list_tasks',
  description: `List all tasks. Filter by status or label. Returns count and task array.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'waiting', 'running', 'completed', 'failed', 'cancelled', 'rate_limited', 'timed_out'],
        description: 'Filter by status.',
      },
      label: {
        type: 'string',
        description: 'Filter by label.',
      },
    },
    required: [],
  },
};

export async function handleListTasks(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ListTasksSchema.parse(args || {});
    const allTasks = taskManager.getAllTasks();

    let filtered = allTasks;

    // Filter by status if provided
    if (parsed.status) {
      filtered = filtered.filter(t => t.status === parsed.status);
    }

    // Filter by label if provided
    if (parsed.label) {
      filtered = filtered.filter(t => t.labels?.includes(parsed.label!));
    }

    if (filtered.length === 0) {
      if (parsed.status || parsed.label) {
        const filterParts = [
          parsed.status ? `status: ${displayStatus(parsed.status)}` : '',
          parsed.label ? `label: ${parsed.label}` : '',
        ].filter(Boolean).join(', ');
        return mcpText(`No tasks matching filter (${filterParts}).\nUse \`list_tasks\` without filters to see all.`);
      }
      return mcpText('No tasks found. Use `spawn_task` to create one.');
    }

    const filterLabel = parsed.status ? displayStatus(parsed.status) : 'total';
    const header = `## Tasks (${filtered.length} ${filterLabel})`;

    const rows = filtered.map(t => {
      let statusStr = displayStatus(t.status);
      if (t.provider) statusStr += ` (${t.provider})`;
      if (t.status === TaskStatus.WAITING && t.dependsOn?.length) {
        statusStr += ` -> ${t.dependsOn.join(', ')}`;
      }
      if (t.status === TaskStatus.RATE_LIMITED && t.retryInfo) {
        statusStr += ` (retry ${t.retryInfo.retryCount}/${t.retryInfo.maxRetries})`;
      }
      if (t.fallbackAttempted) statusStr += ' [fallback]';

      return [
        `**${t.id}**`,
        statusStr,
        formatLabels(t.labels) || '--',
      ];
    });

    const table = formatTable(['Task', 'Status', 'Labels'], rows);
    return mcpText(join(header, '', table, '', 'Check details with `get_status`.'));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown',
      'Check status filter is valid: pending, running, completed, failed, cancelled, rate_limited.'
    ));
  }
}
