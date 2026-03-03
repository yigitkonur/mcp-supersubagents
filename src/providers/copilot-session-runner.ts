/**
 * Copilot Session Runner
 *
 * Bridge between the ProviderAdapter interface and the existing
 * sdk-spawner.ts internals. Delegates to runSDKSession (which is
 * not exported) by re-implementing the spawn flow using the
 * existing exported spawnCopilotTask() function.
 *
 * The key difference from direct spawnCopilotTask() usage:
 * - Task is already created in PENDING state by shared-spawn.ts
 * - We only need to start the SDK session for the existing taskId
 *
 * This file uses the existing executeWaitingTask() pattern where
 * the task already exists and just needs session startup.
 */

import type { ProviderSpawnOptions } from './types.js';
import { taskManager } from '../services/task-manager.js';
import { isTerminalStatus, TaskStatus, DEFAULT_AGENT_MODE } from '../types.js';

/**
 * Run a Copilot SDK session for an existing task.
 * Called by CopilotProviderAdapter.spawn().
 */
export async function runCopilotSession(options: ProviderSpawnOptions): Promise<void> {
  const { taskId, prompt, cwd, model, timeout, mode, reasoningEffort } = options;

  const task = taskManager.getTask(taskId);
  if (!task || isTerminalStatus(task.status)) {
    console.error(`[copilot-session-runner] Task ${taskId} not found or already terminal`);
    return;
  }

  // Import the existing spawner and session infrastructure
  // Using lazy imports to prevent circular dependencies
  const { executeWaitingTask } = await import('../services/sdk-spawner.js');

  // executeWaitingTask expects a TaskState-like object with the spawn parameters.
  // We update the task with the necessary fields, then delegate.
  taskManager.updateTask(taskId, {
    prompt,
    cwd,
    model,
    timeout,
    mode: mode ?? DEFAULT_AGENT_MODE,
  });

  // executeWaitingTask handles: PENDING→RUNNING, session creation, binding,
  // mode activation, prompt send, and all error/fallback paths.
  try {
    await executeWaitingTask(task);
  } catch (err) {
    // executeWaitingTask handles its own errors internally via setImmediate.
    // If it throws, it's an unexpected startup error.
    const currentTask = taskManager.getTask(taskId);
    if (currentTask && !isTerminalStatus(currentTask.status)) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: `Copilot session startup failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      });
    }
  }
}
