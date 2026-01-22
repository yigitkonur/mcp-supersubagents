import { execa } from 'execa';
import { existsSync } from 'fs';
import { taskManager } from './task-manager.js';
import { clientContext } from './client-context.js';
import { TaskStatus, SpawnOptions } from '../types.js';
import { DEFAULT_MODEL } from '../models.js';

const COPILOT_PATH = process.env.COPILOT_PATH || '/opt/homebrew/bin/copilot';

export async function spawnCopilotProcess(options: SpawnOptions): Promise<string> {
  const prompt = options.prompt?.trim() || '';
  
  // Use provided cwd, or client's first root, or server cwd as fallback
  const cwd = options.cwd && existsSync(options.cwd) 
    ? options.cwd 
    : clientContext.getDefaultCwd();
  
  const model = options.model || DEFAULT_MODEL;

  const task = taskManager.createTask(prompt, cwd, model, {
    autonomous: options.autonomous ?? true,
    isResume: !!options.resumeSessionId,
  });

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
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        exitCode: result.exitCode ?? 1,
        endTime: new Date().toISOString(),
        error: result.stderr || result.shortMessage || 'Unknown error',
        process: undefined,
      });
    }
  } catch (error) {
    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      endTime: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
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
