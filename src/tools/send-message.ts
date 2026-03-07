/**
 * Send Message Tool - Send a new message to an existing task session.
 *
 * - Can send custom messages (not just empty prompt)
 * - Default message is "continue" for seamless continuation
 * - Works with any terminal task that has a session ID
 */

import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { providerRegistry } from '../providers/registry.js';
import { progressRegistry } from '../services/progress-registry.js';
import { TaskStatus } from '../types.js';
import type { ToolContext } from '../types.js';
import { mcpText, mcpError } from '../utils/format.js';
import { TASK_TIMEOUT_MAX_MS, TASK_TIMEOUT_MIN_MS, TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';
const resumeInProgress = new Set<string>();

const SendMessageSchema = z.object({
  task_id: z.string().min(1),
  message: z.string().default('continue').optional().describe('Message to send (default: "continue")'),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).optional(),
  cwd: z.string().optional(),
});

export const messageAgentTool = {
  name: 'message-agent',
  description: `Send a follow-up message to an existing agent session. Resumes the session — the agent continues from where it left off.

**Returns a NEW task_id** — the original task stays terminal. Monitor the new ID for progress.

**When to call:** Continue a completed/failed/rate-limited agent with follow-up instructions, or resume with default "continue".

**Find task_id:** Read \`task:///all\` — look for \`can_send_message: true\`.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to send message to. Get from resource task:///all.',
      },
      message: {
        type: 'string',
        default: 'continue',
        description: 'Message to send. Default: "continue" (resumes where it left off).',
      },
      timeout: {
        type: 'integer',
        minimum: TASK_TIMEOUT_MIN_MS,
        maximum: TASK_TIMEOUT_MAX_MS,
        description: `Max execution time in milliseconds. Default: inherited from original task. Max: 1 hr (${TASK_TIMEOUT_MAX_MS}ms).`,
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Auto-detected from original task if omitted.',
      },
    },
    required: ['task_id'],
  },
  annotations: {
    title: 'Message Agent',
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
      'This task cannot receive messages. Use a launch-* tool to create a new task.'
    );
  }

  // Provider capability check: only providers that support session resume can receive messages
  const capabilities = providerRegistry.getCapabilities(task.provider);
  if (!capabilities?.supportsSessionResume) {
    return mcpError(
      `This task ran on ${task.provider ?? 'an unknown provider'} which does not support session resume`,
      'Use a launch-* tool to start a new task with the original prompt.'
    );
  }

  // Check if the session is still alive via the provider-specific SDK client manager.
  // For Copilot: sessions can be destroyed during unbind, sweeps, or rotation.
  const { sdkClientManager } = await import('../services/sdk-client-manager.js');
  if (!sdkClientManager.getSession(task.sessionId)) {
    return mcpError(
      `Session "${task.sessionId}" is no longer active`,
      'The session was destroyed (unbind, sweep, or rotation). Use a launch-* tool to start a new task.'
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
        'Wait for the task to complete, or use `cancel-agent` first.'
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
  const timeout = parsed.timeout || task.timeout || TASK_TIMEOUT_DEFAULT_MS;
  const message = (parsed.message || '').trim() || 'continue';

  // If the task is RATE_LIMITED, mark it FAILED before spawning
  // to prevent the auto-retry scheduler from also spawning a duplicate.
  if (task.status === TaskStatus.RATE_LIMITED) {
    taskManager.updateTask(task.id, {
      status: TaskStatus.FAILED,
      error: 'Superseded by manual send_message resume',
    });
  }

  resumeInProgress.add(taskId);
  try {
    // Route through the provider's sendMessage() method
    const provider = providerRegistry.getProvider(task.provider);
    if (!provider) {
      return mcpError(
        `Provider "${task.provider}" is not registered`,
        'Use a launch-* tool to start a new task.'
      );
    }

    if (!provider.sendMessage) {
      return mcpError(
        `Provider "${task.provider}" does not support sendMessage`,
        'Use a launch-* tool to start a new task with the original prompt.'
      );
    }

    const newTaskId = await provider.sendMessage(taskId, message, {
      taskId,
      prompt: message,
      cwd,
      model: task.model ?? 'claude-sonnet-4.6',
      timeout,
    });

    const newTask = taskManager.getTask(newTaskId);

    if (ctx?.progressToken != null) {
      progressRegistry.register(newTaskId, ctx.progressToken, ctx.sendNotification);
      progressRegistry.sendProgress(newTaskId, `Sent message to session ${sessionId} as task ${newTaskId}`);
    }

    const parts: (string | null)[] = [
      `✅ **Message sent**`,
      `task_id: \`${newTaskId}\``,
      '',
      `**Message:** "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`,
      `**Continued from:** \`${task.id}\``,
      '',
      newTask?.outputFilePath ? `read logs: \`cat -n ${newTask.outputFilePath}\`` : null,
      newTask?.outputFilePath ? `Use \`cat -n\` to read with line numbers, then on subsequent reads use \`tail -n +<N>\` to skip already-read lines.` : null,
      '',
      '**What to do next:**',
      '- If you need to launch additional agents, do so now — agents run in parallel.',
      `- Once all agents are launched, run \`sleep 30\` to give them time to work, then read \`task:///${newTaskId}\` to check status.`,
      '- On each subsequent check, increase the wait: `sleep 60`, then `sleep 90`, `sleep 120`, `sleep 150`, up to `sleep 180` max.',
      newTask?.outputFilePath ? `- Quick progress check: \`wc -l ${newTask.outputFilePath}\` — if the line count is growing, the agent is still working.` : null,
    ];

    return mcpText(parts.filter(Boolean).join('\n'));
  } catch (error) {
    return mcpError(
      error instanceof Error ? error.message : 'Failed to send message',
      'Check that the task session is still valid. Try creating a new task with a launch-* tool instead.'
    );
  } finally {
    resumeInProgress.delete(taskId);
  }
}
