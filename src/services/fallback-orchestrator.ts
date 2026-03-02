import type { CopilotSession } from '@github/copilot-sdk';
import { taskManager } from './task-manager.js';
import { isTerminalStatus, TaskStatus, type FallbackReason } from '../types.js';
import { TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';
import { buildHandoffPromptFromSession } from './session-snapshot.js';
import { runClaudeCodeSession } from './claude-code-runner.js';

export interface FallbackRequest {
  reason: FallbackReason;
  errorMessage?: string;
  session?: CopilotSession;
  cwd?: string;
  promptOverride?: string;
  awaitCompletion?: boolean;
}

/**
 * Start Claude fallback exactly once per task.
 * Uses task.fallbackAttempted as the single-flight guard.
 */
export async function triggerClaudeFallback(taskId: string, request: FallbackRequest): Promise<boolean> {
  const task = taskManager.getTask(taskId);
  if (!task || isTerminalStatus(task.status)) {
    return false;
  }

  if (task.fallbackAttempted) {
    return false;
  }

  // Re-check terminal state BEFORE setting the single-flight guard.
  // If the task reached terminal state between the first check and now,
  // we must not set fallbackAttempted (fallback never actually ran).
  const freshTask = taskManager.getTask(taskId);
  if (!freshTask || isTerminalStatus(freshTask.status)) {
    return false;
  }

  taskManager.updateTask(taskId, {
    fallbackAttempted: true,
    switchAttempted: true,
  });

  const cwd = request.cwd || freshTask.cwd || process.cwd();
  const taskTimeout = freshTask.timeout ?? TASK_TIMEOUT_DEFAULT_MS;
  const elapsed = Date.now() - new Date(freshTask.startTime).getTime();
  const timeoutRemaining = Math.max(5 * 60 * 1000, taskTimeout - elapsed); // At least 5 minutes for Claude fallback

  const fallbackPrompt = request.promptOverride ?? await buildHandoffPromptFromSession(
    freshTask,
    request.session,
    5,
    request.reason,
  );

  if (request.errorMessage) {
    taskManager.appendOutput(
      taskId,
      `\n[system] Copilot error: ${request.errorMessage}\n[system] Switching to Claude Agent SDK...\n`
    );
  }

  const run = runClaudeCodeSession(taskId, fallbackPrompt, cwd, timeoutRemaining, {
    fallbackReason: request.reason,
    preferredModel: freshTask.model,
    mode: freshTask.mode,
  });

  if (request.awaitCompletion) {
    await run;
  } else {
    run.catch((err) => {
      console.error(`[fallback-orchestrator] Claude fallback failed for ${taskId}:`, err);
      // Mark task as FAILED if it's still non-terminal
      const t = taskManager.getTask(taskId);
      if (t && !isTerminalStatus(t.status)) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.FAILED,
          error: `Claude fallback failed: ${err instanceof Error ? err.message : String(err)}`,
          endTime: new Date().toISOString(),
          exitCode: 1,
        });
      }
    });
  }

  return true;
}
