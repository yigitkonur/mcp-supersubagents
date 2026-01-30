import { execa } from 'execa';
import { existsSync } from 'fs';
import { taskManager } from './task-manager.js';
import { clientContext } from './client-context.js';
import { TaskStatus, SpawnOptions, TaskState } from '../types.js';
import { resolveModel } from '../models.js';
import { isRateLimitError, createRetryInfo } from './retry-queue.js';

const COPILOT_PATH = process.env.COPILOT_PATH || '/opt/homebrew/bin/copilot';
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
const FORCE_RATE_LIMIT = process.env.FORCE_RATE_LIMIT === '1';

export async function spawnCopilotProcess(options: SpawnOptions): Promise<string> {
  const prompt = options.prompt?.trim() || '';

  // Use provided cwd, or client's first root, or server cwd as fallback
  const cwd = options.cwd && existsSync(options.cwd)
    ? options.cwd
    : clientContext.getDefaultCwd();

  const model = resolveModel(options.model);

  const task = taskManager.createTask(prompt, cwd, model, {
    autonomous: options.autonomous ?? true,
    isResume: !!options.resumeSessionId,
    retryInfo: options.retryInfo,
    dependsOn: options.dependsOn,
    labels: options.labels,
    provider: options.provider || 'copilot',
    fallbackAttempted: options.fallbackAttempted,
  });

  // If task is waiting for dependencies, don't start execution yet
  if (task.status === TaskStatus.WAITING) {
    console.error(`[process-spawner] Task ${task.id} waiting for dependencies: ${task.dependsOn?.join(', ')}`);
    return task.id;
  }

  const args: string[] = [];

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  } else if (prompt) {
    args.push('-p', prompt);
  }

  args.push('--allow-all', '-s', '--model', model);

  if (options.autonomous !== false) {
    args.push('--no-ask-user');
  }

  setImmediate(() => {
    runProcess(task.id, args, cwd, options.timeout ?? 600000);
  });

  return task.id;
}

/**
 * Execute a waiting task (called when dependencies are satisfied)
 */
export async function executeWaitingTask(task: TaskState): Promise<void> {
  const prompt = task.prompt?.trim() || '';
  const cwd = task.cwd || clientContext.getDefaultCwd();
  const model = resolveModel(task.model);

  const args: string[] = [];

  if (prompt) {
    args.push('-p', prompt);
  }

  args.push('--allow-all', '-s', '--model', model);

  if (task.autonomous !== false) {
    args.push('--no-ask-user');
  }

  // Update status to PENDING before running
  taskManager.updateTask(task.id, { status: TaskStatus.PENDING });

  setImmediate(() => {
    runProcess(task.id, args, cwd, 600000);
  });
}

/**
 * Attempt to run a task via Claude CLI as a fallback when Copilot is rate-limited.
 * Reuses the same task ID — updates status in-place.
 */
async function runClaudeFallback(
  taskId: string,
  prompt: string,
  cwd: string,
  timeout: number
): Promise<{ success: boolean; rateLimited: boolean }> {
  const task = taskManager.getTask(taskId);
  if (!task) {
    return { success: false, rateLimited: false };
  }

  const args: string[] = [
    '--dangerously-skip-permissions',
    '--model', 'sonnet',
    '-p', prompt,
  ];

  try {
    taskManager.appendOutput(taskId, '[fallback] Copilot rate-limited, attempting Claude CLI with sonnet...');
    taskManager.updateTask(taskId, {
      status: TaskStatus.RUNNING,
      provider: 'claude-cli',
      fallbackAttempted: true,
      endTime: undefined,
      error: undefined,
      exitCode: undefined,
    });

    const proc = execa(CLAUDE_CLI_PATH, args, {
      cwd,
      timeout,
      reject: false,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      buffer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    taskManager.updateTask(taskId, {
      pid: proc.pid,
      process: proc,
    });

    if (proc.stdout) {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            taskManager.appendOutput(taskId, `[claude] ${line}`);
          }
        }
      });
      proc.stdout.on('end', () => {
        if (buffer.trim()) {
          taskManager.appendOutput(taskId, `[claude] ${buffer}`);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            taskManager.appendOutput(taskId, `[claude-stderr] ${line}`);
          }
        }
      });
    }

    const result = await proc;

    const currentTask = taskManager.getTask(taskId);
    if (currentTask?.status === TaskStatus.CANCELLED) {
      return { success: false, rateLimited: false };
    }

    if (result.timedOut) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.TIMED_OUT,
        exitCode: result.exitCode ?? 1,
        endTime: new Date().toISOString(),
        error: `Claude CLI fallback timed out after ${timeout}ms`,
        process: undefined,
      });
      return { success: false, rateLimited: false };
    }

    if (result.exitCode === 0) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.COMPLETED,
        exitCode: 0,
        endTime: new Date().toISOString(),
        process: undefined,
      });
      return { success: true, rateLimited: false };
    }

    // Check if Claude CLI also got rate limited
    const errorText = result.stderr || result.shortMessage || 'Unknown error';
    const updatedTask = taskManager.getTask(taskId);
    if (updatedTask && isRateLimitError(updatedTask.output, errorText)) {
      return { success: false, rateLimited: true };
    }

    // Non-rate-limit failure
    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      exitCode: result.exitCode ?? 1,
      endTime: new Date().toISOString(),
      error: `Claude CLI fallback failed: ${errorText}`,
      process: undefined,
    });
    return { success: false, rateLimited: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const updatedTask = taskManager.getTask(taskId);

    if (updatedTask && isRateLimitError(updatedTask.output, errorMessage)) {
      return { success: false, rateLimited: true };
    }

    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      endTime: new Date().toISOString(),
      error: `Claude CLI fallback error: ${errorMessage}`,
      process: undefined,
    });
    return { success: false, rateLimited: false };
  }
}

/**
 * Handle rate limit detection: attempt Claude CLI fallback, or enter exponential backoff.
 */
async function handleRateLimit(
  taskId: string,
  cwd: string,
  timeout: number,
  exitCode: number,
  errorText: string,
): Promise<void> {
  const currentTask = taskManager.getTask(taskId);
  if (!currentTask) return;

  // If fallback not yet attempted, try Claude CLI immediately
  if (!currentTask.fallbackAttempted) {
    console.error(`[process-spawner] Task ${taskId} rate-limited on Copilot, attempting Claude CLI fallback`);
    taskManager.updateTask(taskId, { process: undefined });

    const fallbackResult = await runClaudeFallback(
      taskId,
      currentTask.prompt,
      cwd,
      timeout,
    );

    if (fallbackResult.success) {
      console.error(`[process-spawner] Task ${taskId} completed via Claude CLI fallback`);
      return;
    }

    if (fallbackResult.rateLimited) {
      console.error(`[process-spawner] Task ${taskId} also rate-limited on Claude CLI, entering backoff`);
      const updatedTask = taskManager.getTask(taskId);
      const retryInfo = createRetryInfo(
        updatedTask || currentTask,
        'Rate limit exceeded (both Copilot and Claude CLI)',
        currentTask.retryInfo,
      );
      taskManager.updateTask(taskId, {
        status: TaskStatus.RATE_LIMITED,
        exitCode,
        endTime: new Date().toISOString(),
        error: 'Rate limited on both Copilot and Claude CLI',
        retryInfo,
        fallbackAttempted: true,
        process: undefined,
      });
      console.error(`[process-spawner] Task ${taskId} scheduled retry #${retryInfo.retryCount} at ${retryInfo.nextRetryTime}`);
    }
    // If fallback failed for non-rate-limit reason, task is already marked FAILED by runClaudeFallback
    return;
  }

  // Fallback already attempted — go straight to exponential backoff
  const retryInfo = createRetryInfo(currentTask, 'Rate limit exceeded', currentTask.retryInfo);
  taskManager.updateTask(taskId, {
    status: TaskStatus.RATE_LIMITED,
    exitCode,
    endTime: new Date().toISOString(),
    error: errorText,
    retryInfo,
    process: undefined,
  });
  console.error(`[process-spawner] Task ${taskId} rate-limited, scheduled retry #${retryInfo.retryCount} at ${retryInfo.nextRetryTime}`);
}

async function runProcess(
  taskId: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<void> {
  const task = taskManager.getTask(taskId);
  if (!task) {
    return;
  }

  try {
    const proc = execa(COPILOT_PATH, args, {
      cwd,
      timeout,
      reject: false,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      buffer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutAt = new Date(Date.now() + timeout).toISOString();
    taskManager.updateTask(taskId, {
      status: TaskStatus.RUNNING,
      pid: proc.pid,
      process: proc,
      timeout,
      timeoutAt,
      provider: 'copilot',
    });

    // Testing hook: Force a fake rate limit
    if (FORCE_RATE_LIMIT) {
      console.error(`[process-spawner] FORCE_RATE_LIMIT: Simulating rate limit for task ${taskId}`);
      try { proc.kill('SIGTERM'); } catch {}
      taskManager.appendOutput(taskId, '[test] Simulated rate limit: too many requests, try again in 5 minutes');
      await handleRateLimit(taskId, cwd, timeout, 1, 'Simulated: too many requests');
      return;
    }

    // Event-driven status update: detect process exit immediately
    proc.on('exit', (code, signal) => {
      const currentTask = taskManager.getTask(taskId);
      // Only update if still marked as RUNNING (avoid overwriting intentional cancellations)
      if (currentTask?.status === TaskStatus.RUNNING) {
        console.error(`[process-spawner] Process exit event for ${taskId}: code=${code}, signal=${signal}`);
        // Let the main await handle the actual status update with proper error detection
        // This ensures rate limit detection still works
      }
    });

    if (proc.stdout) {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            taskManager.appendOutput(taskId, line);
          }
        }
      });

      proc.stdout.on('end', () => {
        if (buffer.trim()) {
          taskManager.appendOutput(taskId, buffer);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            taskManager.appendOutput(taskId, `[stderr] ${line}`);
          }
        }
      });
    }

    const result = await proc;

    const currentTask = taskManager.getTask(taskId);
    if (currentTask?.status === TaskStatus.CANCELLED) {
      return;
    }

    // Check if task timed out
    if (result.timedOut) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.TIMED_OUT,
        exitCode: result.exitCode ?? 1,
        endTime: new Date().toISOString(),
        error: `Task timed out after ${timeout}ms`,
        process: undefined,
      });
      console.error(`[process-spawner] Task ${taskId} timed out after ${timeout}ms`);
      return;
    }

    if (result.exitCode === 0) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.COMPLETED,
        exitCode: 0,
        endTime: new Date().toISOString(),
        process: undefined,
      });
    } else {
      // Check if this is a rate limit error
      const currentTask = taskManager.getTask(taskId);
      const errorText = result.stderr || result.shortMessage || 'Unknown error';

      if (currentTask && isRateLimitError(currentTask.output, errorText)) {
        await handleRateLimit(taskId, cwd, timeout, result.exitCode ?? 1, errorText);
      } else {
        taskManager.updateTask(taskId, {
          status: TaskStatus.FAILED,
          exitCode: result.exitCode ?? 1,
          endTime: new Date().toISOString(),
          error: errorText,
          process: undefined,
        });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const currentTask = taskManager.getTask(taskId);

    // Check if exception message indicates rate limiting
    if (currentTask && isRateLimitError(currentTask.output, errorMessage)) {
      await handleRateLimit(taskId, cwd, timeout, 1, errorMessage);
    } else {
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: errorMessage,
        process: undefined,
      });
    }
  }
}

export function checkCopilotInstalled(): boolean {
  try {
    return existsSync(COPILOT_PATH);
  } catch {
    return false;
  }
}

export function checkClaudeCliInstalled(): boolean {
  try {
    if (CLAUDE_CLI_PATH !== 'claude') {
      return existsSync(CLAUDE_CLI_PATH);
    }
    // 'claude' in PATH — assume available
    return true;
  } catch {
    return false;
  }
}
