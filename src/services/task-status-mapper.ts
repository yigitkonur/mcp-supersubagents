import type { Task as MCPTask } from '@modelcontextprotocol/sdk/types.js';
import { TaskState, TaskStatus } from '../types.js';

type MCPStatus = 'working' | 'completed' | 'failed' | 'cancelled';

/**
 * Map internal 8-state model to MCP 5-state model.
 * (input_required is not used since tasks are autonomous)
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
      let msg = `Running`;
      if (task.pid) msg += ` (pid: ${task.pid})`;
      if (task.timeoutAt) {
        const remaining = new Date(task.timeoutAt).getTime() - Date.now();
        if (remaining > 0) {
          msg += `, timeout in ${Math.ceil(remaining / 1000)}s`;
        }
      }
      return msg;
    }

    case TaskStatus.COMPLETED:
      return `Completed${task.exitCode !== undefined ? ` (exit code: ${task.exitCode})` : ''}`;

    case TaskStatus.FAILED:
      return `Failed${task.error ? `: ${task.error.slice(0, 200)}` : ''}`;

    case TaskStatus.CANCELLED:
      return 'Cancelled';

    case TaskStatus.RATE_LIMITED: {
      const attempt = (task.retryInfo?.retryCount ?? 0) + 1;
      const max = task.retryInfo?.maxRetries ?? 6;
      let msg = `Rate limited (attempt ${attempt}/${max})`;
      if (task.retryInfo?.nextRetryTime) {
        const retryAt = new Date(task.retryInfo.nextRetryTime);
        msg += `, retry at ${retryAt.toISOString()}`;
      }
      return msg;
    }

    case TaskStatus.TIMED_OUT:
      return `Timed out${task.timeout ? ` after ${task.timeout}ms` : ''}`;

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

const TASK_TTL_MS = 3_600_000; // 1 hour

/**
 * Build an MCP Task object from internal TaskState.
 */
export function buildMCPTask(task: TaskState): MCPTask {
  return {
    taskId: task.id,
    status: mapInternalStatusToMCP(task.status),
    ttl: TASK_TTL_MS,
    createdAt: task.startTime,
    lastUpdatedAt: task.endTime || task.startTime,
    pollInterval: computePollInterval(task),
    statusMessage: buildStatusMessage(task),
  };
}
