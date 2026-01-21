import { execa } from 'execa';
import { existsSync } from 'fs';
import { taskManager } from './task-manager.js';
import { TaskStatus, SpawnOptions } from '../types.js';
import { sanitizePrompt, validateCwd } from '../utils/sanitize.js';

const COPILOT_PATH = process.env.COPILOT_PATH || '/opt/homebrew/bin/copilot';
const DEFAULT_TIMEOUT = 300000;

const ERROR_PATTERNS = {
  auth: /(?:not authenticated|auth.*failed|login required|unauthorized|401)/i,
  rateLimit: /(?:rate limit|too many requests|429|quota exceeded)/i,
  timeout: /(?:timed? ?out|timeout|ETIMEDOUT)/i,
};

function categorizeError(error: string): 'auth' | 'timeout' | 'rate_limit' | 'unknown' {
  if (ERROR_PATTERNS.auth.test(error)) return 'auth';
  if (ERROR_PATTERNS.rateLimit.test(error)) return 'rate_limit';
  if (ERROR_PATTERNS.timeout.test(error)) return 'timeout';
  return 'unknown';
}

export async function spawnCopilotProcess(options: SpawnOptions): Promise<string> {
  const sanitizedPrompt = sanitizePrompt(options.prompt);
  if (!sanitizedPrompt) {
    throw new Error('Invalid prompt: contains disallowed characters or exceeds length limit');
  }

  const cwd = options.cwd ? validateCwd(options.cwd) : process.cwd();
  if (options.cwd && !cwd) {
    throw new Error('Invalid cwd: directory does not exist');
  }

  const task = taskManager.createTask(sanitizedPrompt, cwd || undefined, options.model, {
    silent: options.silent ?? true,
    autonomous: options.autonomous,
    isResume: !!options.resumeSessionId,
  });

  const args: string[] = [];
  
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  } else {
    args.push('-p', sanitizedPrompt);
  }
  
  args.push('--allow-all-tools');
  
  if (options.silent !== false) {
    args.push('-s');
  }
  
  if (options.autonomous) {
    args.push('--no-ask-user');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  setImmediate(() => {
    runProcess(task.id, args, cwd || process.cwd(), timeout);
  });

  return task.id;
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

    taskManager.updateTask(taskId, {
      status: TaskStatus.RUNNING,
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

    if (result.exitCode === 0) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.COMPLETED,
        exitCode: 0,
        endTime: new Date().toISOString(),
        process: undefined,
      });
    } else {
      const errorMsg = result.stderr || result.shortMessage || 'Unknown error';
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        exitCode: result.exitCode ?? 1,
        endTime: new Date().toISOString(),
        error: errorMsg,
        errorType: categorizeError(errorMsg),
        process: undefined,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      endTime: new Date().toISOString(),
      error: errorMessage,
      errorType: categorizeError(errorMessage),
      process: undefined,
    });
  }
}

export function checkCopilotInstalled(): boolean {
  try {
    return existsSync(COPILOT_PATH);
  } catch {
    return false;
  }
}
