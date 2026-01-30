import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
import { createRetryInfo } from '../services/retry-queue.js';
import { mcpText, formatError, join } from '../utils/format.js';

const SimulateRateLimitSchema = z.object({
  prompt: z.string().min(1).max(50000).optional().default('Test task for rate limit simulation'),
  skip_fallback: z.boolean().optional().default(false),
});

export const simulateRateLimitTool = {
  name: 'simulate_rate_limit',
  description: `[DEBUG] Simulate a rate-limited task to test Claude CLI fallback behavior. Creates a task, marks it as rate-limited, and optionally triggers the fallback flow via manual retry.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Task prompt to use for the simulated task. Default: test prompt.',
      },
      skip_fallback: {
        type: 'boolean',
        description: 'If true, skip triggering retry/fallback and leave task in RATE_LIMITED state for inspection. Default: false.',
      },
    },
    required: [],
  },
};

export async function handleSimulateRateLimit(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = SimulateRateLimitSchema.parse(args || {});

    // Create a task marked as coming from copilot
    const task = taskManager.createTask(parsed.prompt, undefined, undefined, {
      provider: 'copilot',
      fallbackAttempted: parsed.skip_fallback,
    });

    // Simulate some output
    taskManager.appendOutput(task.id, 'Starting task...');
    taskManager.appendOutput(task.id, '[simulated] Error: too many requests, rate limit exceeded');

    // Mark as rate-limited
    const retryInfo = createRetryInfo(task, 'Simulated rate limit');
    taskManager.updateTask(task.id, {
      status: TaskStatus.RATE_LIMITED,
      exitCode: 1,
      endTime: new Date().toISOString(),
      error: 'Simulated: too many requests, rate limit exceeded',
      retryInfo,
    });

    // If not skipping fallback, trigger manual retry which will exercise the fallback path
    let fallbackResult: { success: boolean; newTaskId?: string; error?: string } | undefined;
    if (!parsed.skip_fallback) {
      fallbackResult = await taskManager.triggerManualRetry(task.id);
    }

    let message: string;
    if (fallbackResult?.success) {
      message = join(
        `[Debug] Rate limit simulated for **${task.id}**.`,
        `Fallback retry triggered as **${fallbackResult.newTaskId}**.`,
        'Check status with `get_status`.'
      );
    } else if (parsed.skip_fallback) {
      message = join(
        `[Debug] Rate limit simulated for **${task.id}**.`,
        'Task left in `rate_limited` state for inspection.'
      );
    } else {
      message = join(
        `[Debug] Rate limit simulated for **${task.id}**.`,
        `Fallback trigger failed: ${fallbackResult?.error || 'unknown error'}`
      );
    }

    return mcpText(message);
  } catch (error) {
    return mcpText(formatError(error instanceof Error ? error.message : 'Unknown error'));
  }
}
