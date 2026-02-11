/**
 * Claude Agent SDK Runner
 *
 * Standalone runner that executes tasks using Claude Agent SDK when Copilot accounts are exhausted.
 * Mirrors Copilot SDK session behavior: streams output, tracks metrics, handles errors.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { taskManager } from './task-manager.js';
import { TaskStatus, ToolMetrics, isTerminalStatus } from '../types.js';
import type { SDKMessage, SDKAssistantMessage, SDKResultSuccess, SDKResultError, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';

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

  console.error(`[claude-code-runner] Starting Claude Agent SDK session for task ${taskId}`);
  console.error(`[claude-code-runner] CWD: ${cwd}, Timeout: ${timeout}ms, Resume: ${resumeSessionId || 'none'}`);

  // Guard: don't overwrite if task already reached terminal state (e.g., cancelled)
  if (isTerminalStatus(task.status)) {
    console.error(`[claude-code-runner] Task ${taskId} already terminal (${task.status}), skipping`);
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
        console.error(`[claude-code-runner] Session ID: ${sessionId}`);
      }

      // Handle different message types
      switch (message.type) {
        case 'system': {
          // Log init message to show available tools and model
          const sysMsg = message as SDKSystemMessage;
          if (sysMsg.subtype === 'init') {
            taskManager.appendOutput(taskId, `\n[System] Model: ${sysMsg.model}, Tools: ${sysMsg.tools?.length ?? 0}, Permission: ${sysMsg.permissionMode}\n`);
            if (sysMsg.mcp_servers?.length) {
              taskManager.appendOutput(taskId, `[System] MCP Servers: ${sysMsg.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ')}\n`);
            }
          }
          break;
        }

        case 'assistant': {
          // SDKAssistantMessage wraps BetaMessage in .message property
          // Content is at message.message.content, NOT message.content
          const assistantMsg = message as SDKAssistantMessage;
          const betaMessage = assistantMsg.message;
          turnCount++;
          taskManager.appendOutput(taskId, `\n[Assistant Turn ${turnCount}]\n`);

          if (betaMessage && Array.isArray(betaMessage.content)) {
            for (const block of betaMessage.content) {
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

          // Surface errors (rate limit, auth failures, etc.)
          if (assistantMsg.error) {
            taskManager.appendOutput(taskId, `\n[Assistant Error: ${assistantMsg.error}]\n`);
          }
          break;
        }

        case 'result': {
          // SDKResultMessage has .result (string) for success, not .content
          const resultMsg = message as SDKResultSuccess | SDKResultError;

          if ('result' in resultMsg && typeof resultMsg.result === 'string') {
            taskManager.appendOutput(taskId, `\n[Result]\n${resultMsg.result}\n`);
          }

          // Surface errors from result
          if (resultMsg.subtype !== 'success') {
            const errorResult = resultMsg as SDKResultError;
            taskManager.appendOutput(taskId, `\n[Result Error: ${errorResult.subtype}]\n`);
            if (errorResult.errors?.length) {
              taskManager.appendOutput(taskId, `[Errors: ${errorResult.errors.join('; ')}]\n`);
            }
          }

          // Surface permission denials — critical for diagnosing tool access issues
          if (resultMsg.permission_denials?.length) {
            const denials = resultMsg.permission_denials.map(d => d.tool_name).join(', ');
            taskManager.appendOutput(taskId, `\n[Permission Denials: ${denials}]\n`);
            console.error(`[claude-code-runner] Task ${taskId} had permission denials: ${denials}`);
          }

          // Extract usage — fields are at top level on SDKResultMessage
          if (resultMsg.usage) {
            const usage = resultMsg.usage;
            if ('input_tokens' in usage) totalInputTokens += usage.input_tokens;
            if ('output_tokens' in usage) totalOutputTokens += usage.output_tokens;
          }
          break;
        }

        case 'tool_progress': {
          // Tool progress events - log to show tools are executing
          const toolProgress = message as { tool_name: string; elapsed_time_seconds: number };
          if (toolProgress.tool_name) {
            taskManager.appendOutput(taskId, `[Tool Progress: ${toolProgress.tool_name} ${toolProgress.elapsed_time_seconds}s]\n`);
          }
          break;
        }

        case 'stream_event':
          // Partial streaming event - skip to reduce noise
          break;

        default:
          // Other message types (user, user replay, etc.)
          break;
      }
    }

    clearTimeout(timeoutHandle);

    // Session completed successfully
    console.error(`[claude-code-runner] Task ${taskId} completed successfully`);
    console.error(`[claude-code-runner] Turns: ${turnCount}, Tokens: ${totalInputTokens}/${totalOutputTokens}`);

    // Guard: check if task is already terminal before marking completed
    const freshTask = taskManager.getTask(taskId);
    if (!freshTask || isTerminalStatus(freshTask.status)) {
      console.error(`[claude-code-runner] Task ${taskId} already terminal, skipping completion`);
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
      console.error(`[claude-code-runner] Task ${taskId} already terminal, skipping failure update`);
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
