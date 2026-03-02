/**
 * Send Message Tool - Send a new message to an existing task session.
 *
 * - Can send custom messages (not just empty prompt)
 * - Default message is "continue" for seamless continuation
 * - Works with any terminal task that has a session ID
 */

import { z } from 'zod';
import { taskManager, isSessionActive } from '../services/task-manager.js';
import { spawnCopilotTask } from '../services/sdk-spawner.js';
import { progressRegistry } from '../services/progress-registry.js';
import { sdkClientManager } from '../services/sdk-client-manager.js';
import { TaskStatus } from '../types.js';
import type { ToolContext } from '../types.js';
import { mcpText, mcpError } from '../utils/format.js';
import { TASK_TIMEOUT_MAX_MS, TASK_TIMEOUT_MIN_MS } from '../config/timeouts.js';
const resumeInProgress = new Set<string>();

const SendMessageSchema = z.object({
  task_id: z.string().min(1),
  message: z.string().default('continue').optional().describe('Message to send (default: "continue")'),
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
- \`{ "task_id": "abc123" }\` — Resume with "continue"
- \`{ "task_id": "abc123", "message": "now add unit tests" }\` — Follow-up instruction

**Find task_id:** Read MCP Resource \`task:///all\` for task list with IDs and \`can_send_message\` flag.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to send message to. Get from resource task:///all.',
      },
      message: {
        type: 'string',
        description: 'Message to send to the session. Default: "continue" (resumes where it left off).',
      },
      timeout: {
        type: 'number',
        description: 'Optional. Max execution time in ms. Default: from original task.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Auto-detected from original task if omitted.',
      },
    },
    required: ['task_id'],
  },
  annotations: {
    title: 'Send Message',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export async function handleSendMessage(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed: z.infer<typeof SendMessageSchema>;
  try {
    parsed = SendMessageSchema.parse(args || {});
  } catch (error) {
    return mcpError(
      'Invalid input',
      'Required: task_id (string). Optional: message (string), timeout (number), cwd (string).'
    );
  }

  const taskId = parsed.task_id.toLowerCase().trim();
  const task = taskManager.getTask(taskId);

  if (!task) {
    return mcpError(
      `Task not found: "${taskId}"`,
      'Read resource `task:///all` to find valid task IDs.'
    );
  }

  if (!task.sessionId) {
    return mcpError(
      'Task has no session ID',
      'This task cannot receive messages. Use `spawn_agent` to create a new task.'
    );
  }

  // Finding 2: Reject resume for tasks that ran on Claude fallback —
  // the Copilot session was destroyed and cannot be resumed.
  if (task.provider === 'claude-cli') {
    return mcpError(
      'This task ran on Claude fallback and cannot be resumed via send_message',
      'Use `spawn_agent` to start a new task with the original prompt.'
    );
  }

  // Finding 2: Check if the Copilot session is still alive in the SDK client manager.
  // Sessions can be destroyed during unbind, sweeps, or rotation.
  if (!sdkClientManager.getSession(task.sessionId)) {
    return mcpError(
      `Session "${task.sessionId}" is no longer active`,
      'The session was destroyed (unbind, sweep, or rotation). Use `spawn_agent` to start a new task.'
    );
  }

  // Check if task is in a state that can receive messages
  const allowedStatuses = [
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.RATE_LIMITED,
    TaskStatus.TIMED_OUT,
    TaskStatus.CANCELLED,
  ];

  if (!allowedStatuses.includes(task.status)) {
    if (task.status === TaskStatus.RUNNING) {
      return mcpError(
        'Task is still running',
        'Wait for the task to complete, or use `cancel_task` first.'
      );
    }
    return mcpError(
      `Task status "${task.status}" does not support messaging`,
      'Only completed, failed, rate_limited, timed_out, or cancelled tasks can receive messages.'
    );
  }

  // Guard against concurrent resume attempts
  if (resumeInProgress.has(taskId)) {
    return mcpError(
      'Session resume already in progress',
      'Another send_message is already resuming this task. Wait for it to complete.'
    );
  }

  // FB-006: Check if session is mid-rotation before attempting resume
  const { sdkSessionAdapter } = await import('../services/sdk-session-adapter.js');
  const binding = sdkSessionAdapter.getBinding(taskId);
  if (binding?.rotationInProgress) {
    return mcpError(
      'Task session is currently being rotated to a different account',
      'Please retry in a few seconds once rotation completes.'
    );
  }

  const sessionId = task.sessionId;
  const cwd = parsed.cwd || task.cwd || process.cwd();
  const timeout = parsed.timeout || task.timeout;
  const message = (parsed.message || '').trim() || 'continue';

  // Finding 1: If the task is RATE_LIMITED, mark it FAILED before spawning
  // to prevent the auto-retry scheduler from also spawning a duplicate.
  if (task.status === TaskStatus.RATE_LIMITED) {
    taskManager.updateTask(task.id, {
      status: TaskStatus.FAILED,
      error: 'Superseded by manual send_message resume',
    });
  }

  resumeInProgress.add(taskId);
  try {
    // Spawn a new task with the message to the existing session
    const newTaskId = await spawnCopilotTask({
      prompt: message,
      timeout,
      cwd,
      autonomous: true,
      resumeSessionId: sessionId,
      labels: [...(task.labels || []), `continued-from:${task.id}`],
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
      `**Continued from:** \`${task.id}\``,
      '',
      'The agent is working in the background. MCP notifications will alert on completion—no need to poll.',
      '',
      '**Optional progress check:**',
      newTask?.outputFilePath ? `- \`tail -20 ${newTask.outputFilePath}\` — Last 20 lines` : null,
      `- Read resource: \`task:///${newTaskId}\``,
    ];

    return mcpText(parts.filter(Boolean).join('\n'));
  } catch (error) {
    return mcpError(
      error instanceof Error ? error.message : 'Failed to send message',
      'Check that the task session is still valid. Try creating a new task with `spawn_agent` instead.'
    );
  } finally {
    resumeInProgress.delete(taskId);
  }
}
