/**
 * Claude Agent SDK Runner
 *
 * Standalone runner that executes tasks using Claude Agent SDK when Copilot accounts are exhausted.
 * Mirrors Copilot SDK session behavior: streams output, tracks metrics, handles errors.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { taskManager } from './task-manager.js';
import { TaskStatus, ToolMetrics, isTerminalStatus } from '../types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Run a task using Claude Agent SDK.
 * Streams output to task output file and tracks metrics.
 */
export async function runClaudeCodeSession(
  taskId: string,
  prompt: string,
  cwd: string,
  timeout: number,
  resumeSessionId?: string
): Promise<void> {
  const task = taskManager.getTask(taskId);
  if (!task) {
    console.error(`[claude-code-runner] Task ${taskId} not found`);
    return;
  }

  console.log(`[claude-code-runner] Starting Claude Agent SDK session for task ${taskId}`);
  console.log(`[claude-code-runner] CWD: ${cwd}, Timeout: ${timeout}ms, Resume: ${resumeSessionId || 'none'}`);

  // Guard: don't overwrite if task already reached terminal state (e.g., cancelled)
  if (isTerminalStatus(task.status)) {
    console.log(`[claude-code-runner] Task ${taskId} already terminal (${task.status}), skipping`);
    return;
  }

  // Mark as running with claude-cli provider and set fallback metadata
  taskManager.updateTask(taskId, {
    status: TaskStatus.RUNNING,
    provider: 'claude-cli',
    sessionMetrics: {
      ...task.sessionMetrics,
      quotas: task.sessionMetrics?.quotas || {},
      toolMetrics: task.sessionMetrics?.toolMetrics || {},
      activeSubagents: [],
      completedSubagents: [],
      turnCount: 0,
      totalTokens: { input: 0, output: 0 },
      provider: 'claude-cli',
      fallbackActivated: true,
      fallbackReason: 'copilot-accounts-exhausted',
    },
  });

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    console.warn(`[claude-code-runner] Task ${taskId} timed out after ${timeout}ms`);
    abortController.abort();
  }, timeout);

  try {
    // Create query with options
    const queryStream = query({
      prompt,
      options: {
        cwd,
        abortController,
        model: 'sonnet',
        // Auto-allow tools to avoid permission prompts
        allowedTools: ['*'],
        // Resume if we have a session ID
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    });

    let sessionId: string | undefined;
    let turnCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const toolMetrics: Record<string, ToolMetrics> = {};

    // Stream messages
    for await (const message of queryStream) {
      // Extract session ID from first message
      if (!sessionId && 'session_id' in message) {
        sessionId = message.session_id;
        console.log(`[claude-code-runner] Session ID: ${sessionId}`);
      }

      // Handle different message types
      switch (message.type) {
        case 'assistant':
          // Assistant message - append content
          turnCount++;
          taskManager.appendOutput(taskId, `\n[Assistant Turn ${turnCount}]\n`);

          if ('content' in message && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text' && 'text' in block) {
                taskManager.appendOutput(taskId, block.text);
              } else if (block.type === 'tool_use') {
                // Track tool usage
                const toolName = 'name' in block ? String(block.name) : 'unknown';
                if (!toolMetrics[toolName]) {
                  toolMetrics[toolName] = {
                    toolName,
                    executionCount: 0,
                    successCount: 0,
                    failureCount: 0,
                    totalDurationMs: 0,
                  };
                }
                toolMetrics[toolName].executionCount++;
                taskManager.appendOutput(taskId, `\n[Tool: ${toolName}]\n`);
              }
            }
          }
          break;

        case 'result':
          // Final result message
          if ('content' in message && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text' && 'text' in block) {
                taskManager.appendOutput(taskId, `\n${block.text}\n`);
              }
            }
          }

          // Extract usage if available
          if ('usage' in message && message.usage) {
            const usage = message.usage as { input_tokens?: number; output_tokens?: number };
            if (usage.input_tokens != null) totalInputTokens += usage.input_tokens;
            if (usage.output_tokens != null) totalOutputTokens += usage.output_tokens;
          }
          break;

        case 'stream_event':
          // Partial streaming event - can extract more detailed info if needed
          break;

        default:
          // Other message types (user, system, etc.)
          break;
      }
    }

    clearTimeout(timeoutHandle);

    // Session completed successfully
    console.log(`[claude-code-runner] Task ${taskId} completed successfully`);
    console.log(`[claude-code-runner] Turns: ${turnCount}, Tokens: ${totalInputTokens}/${totalOutputTokens}`);

    // Guard: check if task is already terminal before marking completed
    const freshTask = taskManager.getTask(taskId);
    if (!freshTask || isTerminalStatus(freshTask.status)) {
      console.log(`[claude-code-runner] Task ${taskId} already terminal, skipping completion`);
      return;
    }

    taskManager.updateTask(taskId, {
      status: TaskStatus.COMPLETED,
      endTime: new Date().toISOString(),
      exitCode: 0,
      sessionMetrics: {
        quotas: {},
        toolMetrics,
        activeSubagents: [],
        completedSubagents: [],
        turnCount,
        totalTokens: {
          input: totalInputTokens,
          output: totalOutputTokens,
        },
        provider: 'claude-cli',
        fallbackActivated: true,
        fallbackReason: 'copilot-accounts-exhausted',
      },
      // Store session ID for potential resume
      sessionId,
      session: undefined,
    });
  } catch (error: any) {
    clearTimeout(timeoutHandle);

    // Check if aborted due to timeout
    if (abortController.signal.aborted) {
      console.error(`[claude-code-runner] Task ${taskId} timed out`);

      // Guard: check terminal status before marking timed out
      const freshTask = taskManager.getTask(taskId);
      if (freshTask && !isTerminalStatus(freshTask.status)) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.TIMED_OUT,
          endTime: new Date().toISOString(),
          error: 'Task timed out',
          timeoutReason: 'hard_timeout',
          exitCode: 124,
          session: undefined,
        });
      }
      return;
    }

    // Handle other errors
    console.error(`[claude-code-runner] Task ${taskId} failed:`, error);

    let errorMessage = error.message || 'Unknown error';
    let exitCode = 1;

    // Classify error types
    if (error.name === 'AbortError') {
      errorMessage = 'Task was aborted';
      exitCode = 130;
    } else if (error.message?.includes('CLI not found')) {
      errorMessage = 'Claude Code CLI not found. Install via: npm install -g @anthropic-ai/claude-code';
      exitCode = 127;
    } else if (error.message?.includes('authentication')) {
      errorMessage = 'Claude Code authentication failed. Run: claude login';
      exitCode = 1;
    }

    // Guard: check terminal status before marking failed
    const freshTask = taskManager.getTask(taskId);
    if (!freshTask || isTerminalStatus(freshTask.status)) {
      console.log(`[claude-code-runner] Task ${taskId} already terminal, skipping failure update`);
      return;
    }

    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      endTime: new Date().toISOString(),
      error: errorMessage,
      exitCode,
      failureContext: {
        errorType: error.name || 'unknown',
        message: errorMessage,
        stack: error.stack,
        recoverable: false, // Don't retry Claude Code failures with Copilot
      },
      session: undefined,
    });
  }
}
