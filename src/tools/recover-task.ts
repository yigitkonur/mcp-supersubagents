import { z } from 'zod';
import { taskManager, isProcessAlive } from '../services/task-manager.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { TaskStatus } from '../types.js';
import { mcpText, formatError, join } from '../utils/format.js';
import { TASK_TIMEOUT_MAX_MS, TASK_TIMEOUT_MIN_MS } from '../config/timeouts.js';

const RecoverTaskSchema = z.object({
  task_id: z.string().min(1).describe('Timed out task ID to recover'),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).optional(),
  cwd: z.string().optional(),
});

export const recoverTaskTool = {
  name: 'recover_task',
  description: 'Recover a timed_out task. If session_id exists, resumes it; otherwise suggests spawning a new task.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Timed out task ID to recover.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms for the resumed task (optional).',
      },
      cwd: {
        type: 'string',
        description: 'Working directory override (optional).',
      },
    },
    required: ['task_id'],
  },
};

export async function handleRecoverTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = RecoverTaskSchema.parse(args || {});
    const taskId = parsed.task_id.toLowerCase().trim();

    const task = taskManager.getTask(taskId);
    if (!task) {
      return mcpText(formatError('Task not found', 'Use `list_tasks` to find valid task IDs.'));
    }

    if (task.status !== TaskStatus.TIMED_OUT) {
      return mcpText(formatError(
        `Task is not timed_out (status: ${task.status})`,
        'Only timed_out tasks can be recovered. Use `resume_task` or `spawn_task` if needed.'
      ));
    }

    let cleaned = false;
    if (task.pid && isProcessAlive(task.pid)) {
      try {
        process.kill(task.pid, 'SIGTERM');
        cleaned = true;
      } catch {
        cleaned = false;
      }
    }

    const updatedContext = cleaned
      ? { ...task.timeoutContext, pidAlive: false }
      : task.timeoutContext;

    taskManager.updateTask(task.id, {
      recoveryAttempted: true,
      timeoutContext: updatedContext,
      process: cleaned ? undefined : task.process,
      pid: cleaned ? undefined : task.pid,
    });

    if (!task.sessionId) {
      return mcpText(join(
        `Task **${task.id}** marked for recovery, but no session_id was found.`,
        cleaned ? 'Cleaned up lingering process.' : '',
        'Use `spawn_task` to create a new task with the same prompt.'
      ));
    }

    const newTaskId = await spawnCopilotProcess({
      prompt: '',
      timeout: parsed.timeout ?? task.timeout,
      cwd: parsed.cwd ?? task.cwd,
      autonomous: task.autonomous ?? true,
      resumeSessionId: task.sessionId,
    });

    return mcpText(join(
      `Recovered **${task.id}** as **${newTaskId}** using session \`${task.sessionId}\`.`,
      cleaned ? 'Cleaned up lingering process before resume.' : '',
      'Check status with `get_status`.'
    ));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Ensure `task_id` is provided.'
    ));
  }
}
