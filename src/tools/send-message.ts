/**
 * Send Message Tool - Send a new message to an existing task session.
 * 
 * Replaces the old resume_task tool with better semantics:
 * - Can send custom messages (not just empty prompt)
 * - Default message is "continue" for seamless continuation
 * - Works with any terminal task that has a session ID
 */

import { z } from 'zod';
import { taskManager, isSessionActive } from '../services/task-manager.js';
import { spawnCopilotTask } from '../services/sdk-spawner.js';
import { progressRegistry } from '../services/progress-registry.js';
import { TaskStatus } from '../types.js';
import type { ToolContext } from '../types.js';
import { mcpText, formatError } from '../utils/format.js';
import { TASK_TIMEOUT_MAX_MS, TASK_TIMEOUT_MIN_MS } from '../config/timeouts.js';

const SendMessageSchema = z.object({
  task_id: z.string().min(1).optional().describe('Task ID to send message to'),
  session_id: z.string().min(1).optional().describe('Session ID to resume (alternative to task_id)'),
  message: z.string().optional().default('continue').describe('Message to send (default: "continue")'),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).optional(),
  cwd: z.string().optional(),
});

export const sendMessageTool = {
  name: 'send_message',
  description: `Send a message to an existing task session to continue the conversation.

**Use this to:**
- Continue a completed task with follow-up ("now also add tests")
- Resume a failed/rate-limited task with "continue"
- Add to context without starting fresh

**Default message:** "continue" (picks up where it left off)

**Examples:**
- \`{ "task_id": "abc123" }\` → Resume with "continue"
- \`{ "task_id": "abc123", "message": "now add unit tests" }\` → Follow-up instruction

**Find task_id:** Read MCP Resource \`task:///all\` for task list with IDs and \`can_send_message\` flag.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to send message to. Get from list_tasks or get_status.',
      },
      session_id: {
        type: 'string',
        description: 'Session ID to resume directly (alternative to task_id). Get from get_task_session_detail.',
      },
      message: {
        type: 'string',
        description: 'Message to send to the session. Default: "continue" (resumes where it left off).',
      },
      timeout: {
        type: 'number',
        description: 'Optional. Max execution time in ms. Default: 1800000 (30 min).',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Auto-detected from original task if omitted.',
      },
    },
    required: [],
  },
};

export async function handleSendMessage(args: unknown, ctx?: ToolContext): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = SendMessageSchema.parse(args || {});
    
    // Must provide either task_id or session_id
    if (!parsed.task_id && !parsed.session_id) {
      return mcpText(formatError(
        'Missing task_id or session_id',
        'Provide either task_id (from list_tasks) or session_id (from get_task_session_detail).'
      ));
    }

    let sessionId: string;
    let cwd: string;
    let timeout: number | undefined = parsed.timeout;
    let originalTaskId: string | undefined;

    if (parsed.task_id) {
      // Get session from task
      const taskId = parsed.task_id.toLowerCase().trim();
      const task = taskManager.getTask(taskId);
      
      if (!task) {
        return mcpText(formatError('Task not found', 'Use `list_tasks` to find valid task IDs.'));
      }

      if (!task.sessionId) {
        return mcpText(formatError(
          'Task has no session ID',
          'This task cannot receive messages. Use `spawn_task` to create a new task.'
        ));
      }

      // Check if task is in a state that can receive messages
      const allowedStatuses = [
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.RATE_LIMITED,
        TaskStatus.TIMED_OUT,
      ];
      
      if (!allowedStatuses.includes(task.status)) {
        if (task.status === TaskStatus.RUNNING) {
          return mcpText(formatError(
            'Task is still running',
            'Wait for the task to complete, or use `cancel_task` first.'
          ));
        }
        return mcpText(formatError(
          `Task status "${task.status}" does not support messaging`,
          'Only completed, failed, rate_limited, or timed_out tasks can receive messages.'
        ));
      }

      sessionId = task.sessionId;
      cwd = parsed.cwd || task.cwd || process.cwd();
      timeout = timeout || task.timeout;
      originalTaskId = task.id;

    } else {
      // Use session_id directly
      sessionId = parsed.session_id!;
      cwd = parsed.cwd || process.cwd();
    }

    const message = parsed.message || 'continue';

    // Spawn a new task with the message to the existing session
    const newTaskId = await spawnCopilotTask({
      prompt: message,
      timeout,
      cwd,
      autonomous: true,
      resumeSessionId: sessionId,
      labels: originalTaskId ? [`continued-from:${originalTaskId}`] : undefined,
    });

    const newTask = taskManager.getTask(newTaskId);

    if (ctx?.progressToken != null) {
      progressRegistry.register(newTaskId, ctx.progressToken, ctx.sendNotification);
      progressRegistry.sendProgress(newTaskId, `Sent message to session ${sessionId} as task ${newTaskId}`);
    }

    const parts: (string | null)[] = [
      `✅ **Message sent**`,
      `task_id: \`${newTaskId}\``,
      newTask?.outputFilePath ? `output_file: \`${newTask.outputFilePath}\`` : null,
      '',
      `**Message:** "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`,
      originalTaskId ? `**Continued from:** \`${originalTaskId}\`` : null,
      '',
      'The agent is working in the background. MCP notifications will alert on completion—no need to poll.',
      '',
      '**Optional progress check:**',
      newTask?.outputFilePath ? `- \`tail -20 ${newTask.outputFilePath}\` — Last 20 lines` : null,
      `- Read resource: \`task:///${newTaskId}\``,
    ];

    return mcpText(parts.filter(Boolean).join('\n'));

  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Provide task_id or session_id. Get these from `list_tasks` or `get_task_session_detail`.'
    ));
  }
}
