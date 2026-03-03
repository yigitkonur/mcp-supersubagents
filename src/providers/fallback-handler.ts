/**
 * Generic Fallback Handler
 *
 * Replaces the hardcoded fallback-orchestrator.ts and exhaustion-fallback.ts
 * with a provider-agnostic fallback mechanism that walks the provider chain.
 *
 * When a provider fails, triggerFallback() finds the next available provider
 * in the chain and re-spawns the task through it.
 */

import type { FallbackRequest, ProviderSpawnOptions } from './types.js';
import { providerRegistry } from './registry.js';
import { taskManager } from '../services/task-manager.js';
import { createTaskHandle } from './task-handle-impl.js';
import { isTerminalStatus, TaskStatus, DEFAULT_AGENT_MODE, type Provider } from '../types.js';
import { TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';

/**
 * Trigger fallback to the next available provider in the chain.
 * Uses task.fallbackAttempted as a single-flight guard.
 *
 * Returns true if fallback was started, false if no fallback available.
 */
export async function triggerFallback(request: FallbackRequest): Promise<boolean> {
  const { taskId, failedProviderId, reason, errorMessage, cwd, promptOverride, awaitCompletion } = request;

  const task = taskManager.getTask(taskId);
  if (!task || isTerminalStatus(task.status)) {
    return false;
  }

  // Single-flight guard — only one fallback attempt per task lifetime
  if (task.fallbackAttempted) {
    console.error(`[fallback-handler] Task ${taskId}: fallback already attempted, skipping`);
    return false;
  }

  // Re-check terminal state before setting guard (race condition window)
  const freshTask = taskManager.getTask(taskId);
  if (!freshTask || isTerminalStatus(freshTask.status)) {
    return false;
  }

  // Find the next provider in the chain
  const selection = providerRegistry.selectFallback(failedProviderId);
  if (!selection) {
    console.error(`[fallback-handler] No fallback provider available after '${failedProviderId}'`);
    return false;
  }

  // Set the single-flight guard
  taskManager.updateTask(taskId, {
    fallbackAttempted: true,
    switchAttempted: true,
    provider: selection.provider.id as Provider,
  });

  // Calculate remaining timeout
  const taskTimeout = freshTask.timeout ?? TASK_TIMEOUT_DEFAULT_MS;
  const elapsed = Date.now() - new Date(freshTask.startTime).getTime();
  const timeoutRemaining = Math.max(60_000, taskTimeout - elapsed);

  // Build fallback prompt
  const fallbackPrompt = promptOverride ?? freshTask.prompt;

  if (errorMessage) {
    taskManager.appendOutput(
      taskId,
      `\n[system] ${failedProviderId} error: ${errorMessage}\n[system] Switching to ${selection.provider.displayName}...\n`
    );
  }

  console.error(
    `[fallback-handler] Task ${taskId}: '${failedProviderId}' → '${selection.provider.id}' (reason: ${reason})`
  );

  const spawnOptions: ProviderSpawnOptions = {
    taskId,
    prompt: fallbackPrompt,
    cwd: cwd ?? freshTask.cwd ?? process.cwd(),
    model: freshTask.model ?? 'sonnet',
    timeout: timeoutRemaining,
    mode: freshTask.mode ?? DEFAULT_AGENT_MODE,
    taskType: 'super-coder',
  };

  // Spawn via the fallback provider
  const handle = createTaskHandle(taskId);
  const runFallback = selection.provider.spawn(spawnOptions, handle);

  if (awaitCompletion) {
    await runFallback;
  } else {
    runFallback.catch((err) => {
      console.error(`[fallback-handler] Fallback to '${selection.provider.id}' failed for ${taskId}:`, err);
      const t = taskManager.getTask(taskId);
      if (t && !isTerminalStatus(t.status)) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.FAILED,
          error: `Fallback to ${selection.provider.displayName} failed: ${err instanceof Error ? err.message : String(err)}`,
          endTime: new Date().toISOString(),
          exitCode: 1,
        });
      }
    });
  }

  return true;
}

/**
 * Check if fallback is enabled (at least one more provider in the chain).
 * Replaces isFallbackEnabled() from exhaustion-fallback.ts.
 */
export function isFallbackEnabled(): boolean {
  return providerRegistry.isFallbackEnabled();
}
