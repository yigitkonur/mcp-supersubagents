/**
 * Session Hooks Service - Implements SDK SessionHooks for lifecycle control.
 *
 * Provides:
 * - Structured error handling with retry decisions
 * - Session lifecycle monitoring (start, end)
 * - Pre/post tool use hooks for logging and allow/deny decisions
 * - Centralized hook management per task
 *
 * Note: Tool execution metrics are tracked by sdk-session-adapter using
 * toolCallId-based matching, which is more accurate than the toolName-based
 * matching previously done here. This file no longer tracks tool metrics
 * to avoid duplicate/conflicting writes to task.sessionMetrics.toolMetrics.
 *
 * Uses SessionHooks interface from the SDK.
 */

import type {
  SessionHooks,
  SessionStartHookInput,
  SessionStartHookOutput,
  SessionEndHookInput,
  SessionEndHookOutput,
  ErrorOccurredHookInput,
  ErrorOccurredHookOutput,
  PreToolUseHookInput,
  PreToolUseHookOutput,
  PostToolUseHookInput,
  PostToolUseHookOutput,
} from '@github/copilot-sdk';
import { taskManager } from './task-manager.js';
import type { FailureContext } from '../types.js';

/**
 * Create session hooks for a specific task.
 * These hooks integrate SDK lifecycle events with our task management.
 * Returns SessionHooks with single handler functions as expected by the SDK.
 *
 * Memory safety: Each closure only captures `taskId` (a string primitive) and
 * the module-level `taskManager` singleton — no large objects are retained.
 *
 * Lifecycle: These hooks are passed to the SDK when creating a session and are
 * tied to that session's lifetime. When the SDK destroys the session (on
 * completion, abort, or error), the hook references are released automatically.
 */
export function createSessionHooks(taskId: string): SessionHooks {
  return {
    /**
     * Called when a session starts.
     * Logs session start and sets up monitoring.
     */
    onSessionStart: async (input: SessionStartHookInput): Promise<SessionStartHookOutput | void> => {
      console.error(`[session-hooks] Session started for task ${taskId}: source=${input.source}`);

      // Hook lifecycle → file only (internal metadata)
      taskManager.appendOutputFileOnly(taskId, `[hooks] Session ${input.source === 'resume' ? 'resumed' : 'started'}`);

      // Initialize session metrics — re-read task to avoid TOCTOU if future
      // code adds awaits before this point
      const freshTask = taskManager.getTask(taskId);
      if (freshTask && !freshTask.sessionMetrics) {
        taskManager.updateTask(taskId, {
          sessionMetrics: {
            quotas: {},
            toolMetrics: {},
            activeSubagents: [],
            completedSubagents: [],
            turnCount: 0,
            totalTokens: { input: 0, output: 0 },
          },
        });
      }

      return {
        additionalContext: `Task ID: ${taskId}`,
      };
    },

    /**
     * Called when a session ends.
     * Logs session end and generates summary.
     */
    onSessionEnd: async (input: SessionEndHookInput): Promise<SessionEndHookOutput | void> => {
      console.error(`[session-hooks] Session ended for task ${taskId}: reason=${input.reason}`);

      // Hook lifecycle → file only
      taskManager.appendOutputFileOnly(taskId, `[hooks] Session ended: ${input.reason}`);

      // Generate session summary if available
      if (input.finalMessage) {
        return {
          sessionSummary: input.finalMessage,
        };
      }

      return undefined;
    },

    /**
     * Called when an error occurs.
     * Provides structured error handling with retry decisions.
     */
    onErrorOccurred: async (input: ErrorOccurredHookInput): Promise<ErrorOccurredHookOutput | void> => {
      const errorMsg = String(input.error);
      console.error(`[session-hooks] Error for task ${taskId}: context=${input.errorContext}, recoverable=${input.recoverable}`);

      // Create structured failure context
      const failureContext: FailureContext = {
        errorType: input.errorContext,
        errorContext: input.errorContext,
        recoverable: input.recoverable,
        message: errorMsg,
      };

      // Update task with failure context
      taskManager.updateTask(taskId, { failureContext });
      taskManager.appendOutput(taskId, `[hooks] Error: ${input.errorContext} - ${errorMsg.slice(0, 100)}`);

      // Determine error handling strategy
      if (input.recoverable) {
        // For recoverable errors, suggest retry
        return {
          errorHandling: 'retry',
          retryCount: 3,
          userNotification: `Recoverable error in ${input.errorContext}: ${errorMsg.slice(0, 100)}`,
        };
      }

      // For non-recoverable errors in tool execution, skip the tool
      if (input.errorContext === 'tool_execution') {
        return {
          errorHandling: 'skip',
          userNotification: `Tool execution failed: ${errorMsg.slice(0, 100)}`,
        };
      }

      // For model call errors, abort (let the adapter handle rotation)
      if (input.errorContext === 'model_call') {
        return {
          errorHandling: 'abort',
          userNotification: `Model call failed: ${errorMsg.slice(0, 100)}`,
        };
      }

      return undefined;
    },

    /**
     * Called before a tool is executed.
     * Logs tool start. Metrics are tracked by sdk-session-adapter.
     */
    onPreToolUse: async (input: PreToolUseHookInput): Promise<PreToolUseHookOutput | void> => {
      console.error(`[session-hooks] Tool starting for task ${taskId}: ${input.toolName}`);

      return {
        permissionDecision: 'allow',
      };
    },

    /**
     * Called after a tool is executed.
     * Logs tool completion. Metrics are tracked by sdk-session-adapter.
     */
    onPostToolUse: async (input: PostToolUseHookInput): Promise<PostToolUseHookOutput | void> => {
      const isSuccess = input.toolResult?.resultType === 'success';
      console.error(`[session-hooks] Tool completed for task ${taskId}: ${input.toolName} (${isSuccess ? 'success' : 'failure'})`);

      return undefined;
    },
  };
}

