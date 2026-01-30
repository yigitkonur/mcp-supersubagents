import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import { mcpText, formatError, displayStatus, join } from '../utils/format.js';

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
      return mcpText(formatError('Task not found', 'Use `list_tasks` to find valid task IDs.'));
    }

    const totalLines = task.output.length;
    const offset = Math.min(parsed.offset, totalLines);
    const outputLines = task.output.slice(offset, offset + parsed.limit);
    const nextOffset = offset + outputLines.length;
    const hasMore = nextOffset < totalLines;

    const isTerminal = [
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.CANCELLED,
      TaskStatus.TIMED_OUT,
    ].includes(task.status);

    // Build headline
    const statusStr = displayStatus(task.status);
    let rangeStr: string;
    if (outputLines.length > 0) {
      rangeStr = `lines ${offset}-${nextOffset - 1} of ${totalLines}`;
    } else {
      rangeStr = `${totalLines} lines`;
    }
    const exitInfo = isTerminal && task.exitCode !== undefined ? `, exit code: ${task.exitCode}` : '';
    const headline = `**${task.id}** -- ${statusStr} (${rangeStr}${exitInfo})`;

    // Build body
    let body: string;
    if (outputLines.length > 0) {
      body = outputLines.map(l => `> ${l}`).join('\n');
    } else {
      body = 'No output yet.';
    }

    // Build footer
    let footer: string;
    if (hasMore) {
      const remaining = totalLines - nextOffset;
      footer = `${remaining} more lines available. Use offset \`${nextOffset}\` to continue.`;
    } else if (isTerminal) {
      footer = 'All output retrieved.';
    } else {
      footer = 'Waiting for more output...';
    }

    // Add error if terminal and has error
    const errorLine = task.error && isTerminal ? `**Error:** ${task.error}` : undefined;

    return mcpText(join(headline, '', body, '', errorLine, footer));
  } catch (error) {
    return mcpText(formatError(error instanceof Error ? error.message : 'Unknown error'));
  }
}
