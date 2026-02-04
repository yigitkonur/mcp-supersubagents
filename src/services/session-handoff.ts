/**
 * Session Handoff Service - Enables cross-account continuation of sessions.
 * 
 * Uses SDK's session.getMessages() to export session history and create
 * a summarized handoff to continue on a different account when quota is exhausted.
 * 
 * Based on SDK recommendation:
 * > "Continue with another account" is usually a handoff, not a resume
 */

import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { sdkClientManager } from './sdk-client-manager.js';
import { accountManager } from './account-manager.js';
import { taskManager } from './task-manager.js';
import { spawnCopilotTask } from './sdk-spawner.js';
import type { TaskState } from '../types.js';

const DEFAULT_HISTORY_TURNS = 10;

interface HandoffResult {
  success: boolean;
  newTaskId?: string;
  newSessionId?: string;
  error?: string;
  historyTurns?: number;
  targetAccountIndex?: number;
}

interface MessageSummary {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

/**
 * Extract messages from session events for handoff summary.
 */
function extractMessages(events: SessionEvent[]): MessageSummary[] {
  const messages: MessageSummary[] = [];

  for (const event of events) {
    if (event.type === 'user.message') {
      messages.push({
        role: 'user',
        content: event.data.content,
        timestamp: event.timestamp,
      });
    } else if (event.type === 'assistant.message') {
      messages.push({
        role: 'assistant',
        content: event.data.content,
        timestamp: event.timestamp,
      });
    }
  }

  return messages;
}

/**
 * Build a handoff summary from message history.
 * Keeps the last N turns and summarizes the context.
 */
function buildHandoffSummary(
  messages: MessageSummary[],
  maxTurns: number,
  originalPrompt?: string
): string {
  // Get the last N messages (user + assistant pairs count as 1 turn)
  const recentMessages = messages.slice(-maxTurns * 2);

  const lines: string[] = [
    '## Session Continuation Context',
    '',
    'This is a continuation of a previous session. Here is the relevant context:',
    '',
  ];

  // Include original prompt if available
  if (originalPrompt) {
    lines.push('### Original Task');
    lines.push('```');
    lines.push(originalPrompt.slice(0, 500) + (originalPrompt.length > 500 ? '...' : ''));
    lines.push('```');
    lines.push('');
  }

  // Include recent conversation
  if (recentMessages.length > 0) {
    lines.push('### Recent Conversation');
    lines.push('');

    for (const msg of recentMessages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      // Truncate long messages
      const content = msg.content.length > 300 
        ? msg.content.slice(0, 300) + '...'
        : msg.content;
      lines.push(`**${role}:** ${content}`);
      lines.push('');
    }
  }

  lines.push('### Instructions');
  lines.push('');
  lines.push('Please continue from where the previous session left off. ');
  lines.push('Complete the original task based on the context above.');

  return lines.join('\n');
}

/**
 * Perform a session handoff to a different account.
 * 
 * This exports the session history, rotates to a new account,
 * creates a new session with the summarized context, and continues.
 */
export async function performHandoff(
  taskId: string,
  options: {
    targetAccountIndex?: number;
    includeHistoryTurns?: number;
    additionalPrompt?: string;
  } = {}
): Promise<HandoffResult> {
  const task = taskManager.getTask(taskId);
  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  const historyTurns = options.includeHistoryTurns ?? DEFAULT_HISTORY_TURNS;

  try {
    // Step 1: Export session history
    let messages: MessageSummary[] = [];
    
    if (task.sessionId) {
      try {
        const session = await sdkClientManager.resumeSession(task.cwd || process.cwd(), task.sessionId);
        const events = await session.getMessages();
        messages = extractMessages(events);
        
        // Destroy the old session after extracting history
        await session.destroy();
      } catch (err) {
        console.error(`[session-handoff] Failed to export session history:`, err);
        // Continue without history - we can still handoff with the original prompt
      }
    }

    // Step 2: Rotate to new account
    let targetAccountIndex: number;
    
    if (options.targetAccountIndex !== undefined) {
      // Use specific account if requested
      const tokenCount = accountManager.getTokenCount();
      if (options.targetAccountIndex >= tokenCount) {
        return { 
          success: false, 
          error: `Invalid account index ${options.targetAccountIndex}. Available: 0-${tokenCount - 1}` 
        };
      }
      // Force rotation to specific index
      for (let i = 0; i < options.targetAccountIndex + 1; i++) {
        accountManager.rotateToNext('handoff_target');
      }
      targetAccountIndex = options.targetAccountIndex;
    } else {
      // Rotate to next available account
      const rotationResult = accountManager.rotateToNext('handoff');
      if (!rotationResult.success) {
        return { 
          success: false, 
          error: rotationResult.allExhausted 
            ? 'All accounts exhausted' 
            : rotationResult.error 
        };
      }
      targetAccountIndex = rotationResult.tokenIndex!;
    }

    // Step 3: Build handoff prompt
    const handoffSummary = buildHandoffSummary(messages, historyTurns, task.prompt);
    const fullPrompt = options.additionalPrompt 
      ? `${handoffSummary}\n\n## Additional Instructions\n\n${options.additionalPrompt}`
      : handoffSummary;

    // Step 4: Create new task with handoff context
    const newTaskId = await spawnCopilotTask({
      prompt: fullPrompt,
      cwd: task.cwd,
      model: task.model,
      timeout: task.timeout,
      autonomous: task.autonomous,
      labels: [...(task.labels || []), 'handoff', `from:${taskId}`],
    });

    console.error(`[session-handoff] Handoff complete: ${taskId} -> ${newTaskId} (account #${targetAccountIndex + 1})`);

    // Update original task with handoff info
    taskManager.appendOutput(taskId, `[handoff] Session handed off to task ${newTaskId} on account #${targetAccountIndex + 1}`);

    return {
      success: true,
      newTaskId,
      historyTurns: messages.length > 0 ? Math.min(historyTurns, Math.ceil(messages.length / 2)) : 0,
      targetAccountIndex,
    };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[session-handoff] Handoff failed:`, err);
    return { success: false, error };
  }
}

/**
 * Check if a handoff is recommended for a task.
 * Returns true if the task is rate-limited or has low quota.
 */
export function isHandoffRecommended(task: TaskState): boolean {
  // Check if rate-limited with exhausted retries
  if (task.status === 'rate_limited') {
    if (task.retryInfo && task.retryInfo.retryCount >= task.retryInfo.maxRetries) {
      return true;
    }
  }

  // Check if quota is critically low
  if (task.quotaInfo && task.quotaInfo.remainingPercentage < 1) {
    return true;
  }

  // Check if failure context indicates quota exhaustion
  if (task.failureContext?.statusCode === 429) {
    return true;
  }

  return false;
}

/**
 * Get handoff recommendation details for a task.
 */
export function getHandoffRecommendation(task: TaskState): {
  recommended: boolean;
  reason?: string;
  availableAccounts: number;
} {
  const availableAccounts = accountManager.getTokenCount() - 1; // Excluding current
  const recommended = isHandoffRecommended(task);

  let reason: string | undefined;
  if (recommended) {
    if (task.quotaInfo?.remainingPercentage !== undefined && task.quotaInfo.remainingPercentage < 1) {
      reason = `Quota critically low (${task.quotaInfo.remainingPercentage}% remaining)`;
    } else if (task.failureContext?.statusCode === 429) {
      reason = 'Rate limited (429)';
    } else if (task.retryInfo && task.retryInfo.retryCount >= task.retryInfo.maxRetries) {
      reason = `Max retries exhausted (${task.retryInfo.retryCount}/${task.retryInfo.maxRetries})`;
    }
  }

  return {
    recommended,
    reason,
    availableAccounts: Math.max(0, availableAccounts),
  };
}
