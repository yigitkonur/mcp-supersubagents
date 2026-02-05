/**
 * Session Hooks Service - Implements SDK QueryHooks for lifecycle control.
 * 
 * Provides:
 * - Structured error handling with retry decisions
 * - Session lifecycle monitoring (start, end)
 * - Tool execution telemetry
 * - Centralized hook management per task
 * 
 * Uses QueryHooks interface which expects arrays of hook functions.
 */

import type {
  QueryHooks,
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
import type { FailureContext, ToolMetrics, SessionMetrics } from '../types.js';

// Track tool metrics per task
const taskToolMetrics: Map<string, Map<string, ToolMetrics>> = new Map();

// Track tool execution start times for duration calculation
const toolStartTimes: Map<string, number> = new Map();

/**
 * Create session hooks for a specific task.
 * These hooks integrate SDK lifecycle events with our task management.
 * Returns QueryHooks with arrays of hook functions as expected by the SDK.
 */
export function createSessionHooks(taskId: string): QueryHooks {
  // Initialize tool metrics for this task
  if (!taskToolMetrics.has(taskId)) {
    taskToolMetrics.set(taskId, new Map());
  }

  return {
    /**
     * Called when a session starts.
     * Logs session start and sets up monitoring.
     */
    sessionStart: [
      async (input: SessionStartHookInput): Promise<SessionStartHookOutput | void> => {
        console.error(`[session-hooks] Session started for task ${taskId}: source=${input.source}`);
        
        taskManager.appendOutput(taskId, `[hooks] Session ${input.source === 'resume' ? 'resumed' : 'started'}`);
        
        // Initialize session metrics
        const task = taskManager.getTask(taskId);
        if (task && !task.sessionMetrics) {
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
    ],

    /**
     * Called when a session ends.
     * Captures completion metrics and cleanup.
     */
    sessionEnd: [
      async (input: SessionEndHookInput): Promise<SessionEndHookOutput | void> => {
        console.error(`[session-hooks] Session ended for task ${taskId}: reason=${input.reason}`);
        
        taskManager.appendOutput(taskId, `[hooks] Session ended: ${input.reason}`);

        // Finalize tool metrics
        const toolMetrics = taskToolMetrics.get(taskId);
        if (toolMetrics && toolMetrics.size > 0) {
          const metricsObj: Record<string, ToolMetrics> = {};
          for (const [name, metrics] of toolMetrics) {
            metricsObj[name] = metrics;
          }
          
          const task = taskManager.getTask(taskId);
          if (task?.sessionMetrics) {
            taskManager.updateTask(taskId, {
              sessionMetrics: {
                ...task.sessionMetrics,
                toolMetrics: metricsObj,
              },
            });
          }
        }

        // Generate session summary if available
        if (input.finalMessage) {
          return {
            sessionSummary: input.finalMessage,
          };
        }

        return undefined;
      },
    ],

    /**
     * Called when an error occurs.
     * Provides structured error handling with retry decisions.
     */
    errorOccurred: [
      async (input: ErrorOccurredHookInput): Promise<ErrorOccurredHookOutput | void> => {
        const errorMsg = input.error instanceof Error ? input.error.message : String(input.error);
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
    ],

    /**
     * Called before a tool is executed.
     * Tracks tool execution start for metrics.
     */
    preToolUse: [
      async (input: PreToolUseHookInput): Promise<PreToolUseHookOutput | void> => {
        // Track start time for duration calculation
        const recentKey = `${taskId}:${input.toolName}:recent`;
        toolStartTimes.set(recentKey, Date.now());

        console.error(`[session-hooks] Tool starting for task ${taskId}: ${input.toolName}`);

        return {
          decision: 'allow',
        };
      },
    ],

    /**
     * Called after a tool is executed.
     * Collects tool execution metrics.
     */
    postToolUse: [
      async (input: PostToolUseHookInput): Promise<PostToolUseHookOutput | void> => {
        const recentKey = `${taskId}:${input.toolName}:recent`;
        const startTime = toolStartTimes.get(recentKey);
        const duration = startTime ? Date.now() - startTime : 0;
        toolStartTimes.delete(recentKey);

        // Update tool metrics
        const toolMetrics = taskToolMetrics.get(taskId) || new Map();
        const existing = toolMetrics.get(input.toolName) || {
          toolName: input.toolName,
          executionCount: 0,
          successCount: 0,
          failureCount: 0,
          totalDurationMs: 0,
        };

        existing.executionCount++;
        existing.totalDurationMs += duration;
        existing.lastExecutedAt = new Date().toISOString();

        // Check result type from toolResult
        const isSuccess = input.toolResult?.result_type === 'SUCCESS';
        if (isSuccess) {
          existing.successCount++;
        } else {
          existing.failureCount++;
        }

        toolMetrics.set(input.toolName, existing);
        taskToolMetrics.set(taskId, toolMetrics);

        console.error(`[session-hooks] Tool completed for task ${taskId}: ${input.toolName} (${duration}ms, ${isSuccess ? 'success' : 'failure'})`);

        return undefined;
      },
    ],
  };
}

/**
 * Get tool metrics for a task.
 */
export function getTaskToolMetrics(taskId: string): Record<string, ToolMetrics> {
  const metrics = taskToolMetrics.get(taskId);
  if (!metrics) return {};

  const result: Record<string, ToolMetrics> = {};
  for (const [name, m] of metrics) {
    result[name] = m;
  }
  return result;
}

/**
 * Clear tool metrics for a task (call on task cleanup).
 */
export function clearTaskToolMetrics(taskId: string): void {
  taskToolMetrics.delete(taskId);
  
  // Also clean up any lingering start times
  for (const key of toolStartTimes.keys()) {
    if (key.startsWith(`${taskId}:`)) {
      toolStartTimes.delete(key);
    }
  }
}

/**
 * Get aggregated tool metrics across all tasks.
 */
export function getGlobalToolMetrics(): Record<string, ToolMetrics> {
  const global: Record<string, ToolMetrics> = {};

  for (const taskMetrics of taskToolMetrics.values()) {
    for (const [name, metrics] of taskMetrics) {
      if (!global[name]) {
        global[name] = { ...metrics };
      } else {
        global[name].executionCount += metrics.executionCount;
        global[name].successCount += metrics.successCount;
        global[name].failureCount += metrics.failureCount;
        global[name].totalDurationMs += metrics.totalDurationMs;
        if (metrics.lastExecutedAt && (!global[name].lastExecutedAt || metrics.lastExecutedAt > global[name].lastExecutedAt)) {
          global[name].lastExecutedAt = metrics.lastExecutedAt;
        }
      }
    }
  }

  return global;
}
