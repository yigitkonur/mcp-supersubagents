import type { Task as MCPTask } from '@modelcontextprotocol/sdk/types.js';
import { TaskState, TaskStatus, isTerminalStatus } from '../types.js';
import { TASK_TTL_MS } from '../config/timeouts.js';

type MCPStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/**
 * Map internal 8-state model to MCP 5-state model.
 * Note: input_required is handled separately in buildMCPTask based on pendingQuestion.
 */
export function mapInternalStatusToMCP(status: TaskStatus): MCPStatus {
  switch (status) {
    case TaskStatus.PENDING:
    case TaskStatus.WAITING:
    case TaskStatus.RUNNING:
    case TaskStatus.RATE_LIMITED:
      return 'working';
    case TaskStatus.COMPLETED:
      return 'completed';
    case TaskStatus.FAILED:
    case TaskStatus.TIMED_OUT:
      return 'failed';
    case TaskStatus.CANCELLED:
      return 'cancelled';
    default:
      return 'working';
  }
}

/**
 * Build a human-readable status message from internal task state.
 * Now includes SDK metrics for richer status reporting.
 */
export function buildStatusMessage(task: TaskState): string {
  switch (task.status) {
    case TaskStatus.PENDING:
      return 'Pending: awaiting execution slot';

    case TaskStatus.WAITING: {
      const deps = task.dependsOn?.join(', ') || 'unknown';
      return `Waiting for dependencies: ${deps}`;
    }

    case TaskStatus.RUNNING: {
      const parts: string[] = ['Running'];
      
      if (task.sessionId) {
        parts.push(`session: ${task.sessionId.slice(0, 8)}...`);
      }
      
      // Include turn count from session metrics
      if (task.sessionMetrics?.turnCount) {
        parts.push(`turns: ${task.sessionMetrics.turnCount}`);
      }
      
      // Include active subagents
      if (task.sessionMetrics?.activeSubagents?.length) {
        const subagentNames = task.sessionMetrics.activeSubagents.map(s => s.agentDisplayName).join(', ');
        parts.push(`subagents: ${subagentNames}`);
      }
      
      // Include token usage
      if (task.sessionMetrics?.totalTokens) {
        const { input, output } = task.sessionMetrics.totalTokens;
        if (input > 0 || output > 0) {
          parts.push(`tokens: ${input}in/${output}out`);
        }
      }
      
      if (task.timeoutAt) {
        const remaining = new Date(task.timeoutAt).getTime() - Date.now();
        if (remaining > 0) {
          parts.push(`timeout in ${Math.ceil(remaining / 1000)}s`);
        }
      }
      
      // Include quota warning if low
      if (task.quotaInfo && task.quotaInfo.remainingPercentage <= 10) {
        parts.push(`quota: ${task.quotaInfo.remainingPercentage}%`);
      }
      
      return parts.join(' | ');
    }

    case TaskStatus.COMPLETED: {
      const parts: string[] = ['Completed'];
      
      if (task.exitCode !== undefined) {
        parts.push(`exit: ${task.exitCode}`);
      }
      
      // Include completion metrics
      if (task.completionMetrics) {
        const { totalApiCalls, totalApiDurationMs, codeChanges } = task.completionMetrics;
        
        if (totalApiCalls > 0) {
          parts.push(`api: ${totalApiCalls} calls`);
        }
        if (totalApiDurationMs > 0) {
          parts.push(`duration: ${Math.round(totalApiDurationMs / 1000)}s`);
        }
        if (codeChanges.linesAdded > 0 || codeChanges.linesRemoved > 0) {
          parts.push(`code: +${codeChanges.linesAdded}/-${codeChanges.linesRemoved}`);
        }
        if (codeChanges.filesModified.length > 0) {
          parts.push(`files: ${codeChanges.filesModified.length}`);
        }
      }
      
      // Include session metrics summary
      if (task.sessionMetrics) {
        const { turnCount, totalTokens, completedSubagents } = task.sessionMetrics;
        if (turnCount > 0) {
          parts.push(`turns: ${turnCount}`);
        }
        if (totalTokens.input > 0 || totalTokens.output > 0) {
          parts.push(`tokens: ${totalTokens.input + totalTokens.output}`);
        }
        if (completedSubagents?.length > 0) {
          parts.push(`subagents: ${completedSubagents.length}`);
        }
      }
      
      return parts.join(' | ');
    }

    case TaskStatus.FAILED: {
      const parts: string[] = ['Failed'];
      
      // Use structured failure context if available
      if (task.failureContext) {
        const { errorType, statusCode, errorContext } = task.failureContext;
        if (statusCode) {
          parts.push(`status: ${statusCode}`);
        }
        if (errorType) {
          parts.push(`type: ${errorType}`);
        }
        if (errorContext) {
          parts.push(`context: ${errorContext}`);
        }
        if (task.failureContext.recoverable) {
          parts.push('recoverable');
        }
      }
      
      // Truncated error message
      if (task.error) {
        const truncated = task.error.length > 100 ? task.error.slice(0, 100) + '...' : task.error;
        parts.push(truncated);
      }
      
      return parts.join(' | ');
    }

    case TaskStatus.CANCELLED:
      return 'Cancelled';

    case TaskStatus.RATE_LIMITED: {
      const parts: string[] = ['⏸ Paused (rate limited)'];
      
      const attempt = (task.retryInfo?.retryCount ?? 0) + 1;
      const max = task.retryInfo?.maxRetries ?? 6;
      parts.push(`attempt ${attempt}/${max}`);
      
      // Use structured failure context for status code
      if (task.failureContext?.statusCode) {
        parts.push(`status: ${task.failureContext.statusCode}`);
      }
      
      // Use quota info for reset time if available
      if (task.quotaInfo?.resetDate) {
        const resetAt = new Date(task.quotaInfo.resetDate);
        parts.push(`resets: ${resetAt.toISOString()}`);
      } else if (task.retryInfo?.nextRetryTime) {
        const retryAt = new Date(task.retryInfo.nextRetryTime);
        parts.push(`retry at: ${retryAt.toISOString()}`);
      }
      
      // Add human-readable wait time
      if (task.retryInfo?.nextRetryTime) {
        const waitMs = new Date(task.retryInfo.nextRetryTime).getTime() - Date.now();
        if (waitMs > 0) {
          const waitMin = Math.ceil(waitMs / 60000);
          parts.push(`retrying in ~${waitMin}min`);
        }
      }
      
      return parts.join(' | ');
    }

    case TaskStatus.TIMED_OUT: {
      const parts: string[] = ['Timed out'];
      
      if (task.timeout) {
        parts.push(`after ${task.timeout}ms`);
      }
      
      if (task.timeoutReason) {
        parts.push(`reason: ${task.timeoutReason}`);
      }
      
      // Include what was accomplished before timeout
      if (task.sessionMetrics) {
        const { turnCount, totalTokens } = task.sessionMetrics;
        if (turnCount > 0) {
          parts.push(`turns completed: ${turnCount}`);
        }
        if (totalTokens.input > 0 || totalTokens.output > 0) {
          parts.push(`tokens used: ${totalTokens.input + totalTokens.output}`);
        }
      }
      
      return parts.join(' | ');
    }

    default:
      return task.status;
  }
}

/**
 * Compute recommended poll interval based on task state.
 * Returns undefined for terminal states (no polling needed).
 */
export function computePollInterval(task: TaskState): number | undefined {
  switch (task.status) {
    case TaskStatus.PENDING:
    case TaskStatus.RUNNING:
      return 30_000;

    case TaskStatus.WAITING:
      return 60_000;

    case TaskStatus.RATE_LIMITED: {
      // Use quota reset date if available for more accurate polling
      if (task.quotaInfo?.resetDate) {
        const waitMs = new Date(task.quotaInfo.resetDate).getTime() - Date.now();
        return Math.max(30_000, Math.min(waitMs, 300_000)); // Cap at 5 min
      }
      if (task.retryInfo?.nextRetryTime) {
        const waitMs = new Date(task.retryInfo.nextRetryTime).getTime() - Date.now();
        return Math.max(30_000, waitMs);
      }
      return 30_000;
    }

    // Terminal states: no polling
    case TaskStatus.COMPLETED:
    case TaskStatus.FAILED:
    case TaskStatus.CANCELLED:
    case TaskStatus.TIMED_OUT:
      return undefined;

    default:
      return 30_000;
  }
}

function getLastUpdatedAt(task: TaskState): string {
  const candidates = [
    task.endTime,
    task.lastOutputAt,
    task.lastHeartbeatAt,
    task.startTime,
  ].filter((value): value is string => Boolean(value));

  let latest = task.startTime;
  let latestMs = new Date(latest).getTime();

  for (const ts of candidates) {
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = ts;
    }
  }

  return latest;
}

/**
 * Build an MCP Task object from internal TaskState.
 * Includes enhanced status message with SDK metrics.
 */
export function buildMCPTask(task: TaskState): MCPTask {
  const baseStatus = mapInternalStatusToMCP(task.status);
  // Override to input_required when task has a pending question
  const status = task.pendingQuestion && !isTerminalStatus(task.status) ? 'input_required' : baseStatus;
  return {
    taskId: task.id,
    status,
    ttl: TASK_TTL_MS > 0 ? TASK_TTL_MS : null,
    createdAt: task.startTime,
    lastUpdatedAt: getLastUpdatedAt(task),
    pollInterval: computePollInterval(task),
    statusMessage: buildStatusMessage(task),
  };
}
