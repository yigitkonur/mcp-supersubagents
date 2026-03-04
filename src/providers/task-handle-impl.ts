/**
 * TaskHandleImpl — Concrete implementation of TaskHandle
 *
 * Delegates to taskManager and processRegistry internally.
 * Providers receive this via createTaskHandle() and never
 * import the singletons directly.
 */

import type { TaskHandle } from './task-handle.js';
import type { SessionMetrics as HandleSessionMetrics } from './task-handle.js';
import type { TaskState, SubagentInfo } from '../types.js';
import { TaskStatus, isTerminalStatus, DEFAULT_AGENT_MODE } from '../types.js';
import type { AgentMode, Provider } from '../types.js';
import { taskManager } from '../services/task-manager.js';
import { processRegistry } from '../services/process-registry.js';

/**
 * Normalize subagent arrays: providers may return string[] (names only)
 * or SubagentInfo[] (full objects). Ensure we always store SubagentInfo[].
 */
function normalizeSubagents(arr: SubagentInfo[] | string[] | undefined): SubagentInfo[] {
  if (!arr || arr.length === 0) return [];
  if (typeof arr[0] === 'string') {
    return (arr as string[]).map(name => ({
      agentName: name,
      agentDisplayName: name,
      toolCallId: '',
      status: 'completed' as const,
      startedAt: new Date().toISOString(),
    }));
  }
  return arr as SubagentInfo[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class TaskHandleImpl implements TaskHandle {
  private abortCallbacks: Array<() => void> = [];
  private registeredAbortController: AbortController | null = null;

  constructor(readonly taskId: string) {}

  // --- State transitions ---

  markRunning(sessionId?: string): void {
    const updates: Partial<TaskState> = {
      status: TaskStatus.RUNNING,
    };
    if (sessionId) {
      updates.sessionId = sessionId;
    }
    taskManager.updateTask(this.taskId, updates);
  }

  markCompleted(metrics?: HandleSessionMetrics): void {
    const updates: Partial<TaskState> = {
      status: TaskStatus.COMPLETED,
      endTime: new Date().toISOString(),
      exitCode: 0,
      providerState: undefined,
    };
    if (metrics) {
      // Map handle-level metrics to core SessionMetrics type.
      // Handle metrics use simplified types; subagent arrays are normalized
      // from string[] (some providers) to full SubagentInfo[].
      updates.sessionMetrics = {
        quotas: metrics.quotas ?? {},
        toolMetrics: metrics.toolMetrics ?? {},
        activeSubagents: normalizeSubagents(metrics.activeSubagents),
        completedSubagents: normalizeSubagents(metrics.completedSubagents),
        turnCount: metrics.turnCount ?? 0,
        totalTokens: metrics.totalTokens ?? { input: 0, output: 0 },
      };
    }
    taskManager.updateTask(this.taskId, updates);
  }

  markFailed(error: string, exitCode?: number): void {
    taskManager.updateTask(this.taskId, {
      status: TaskStatus.FAILED,
      endTime: new Date().toISOString(),
      error,
      exitCode: exitCode ?? 1,
      providerState: undefined,
    });
  }

  markCancelled(reason: string): void {
    taskManager.updateTask(this.taskId, {
      status: TaskStatus.CANCELLED,
      endTime: new Date().toISOString(),
      error: reason,
      providerState: undefined,
    });
  }

  // --- Output ---

  writeOutput(line: string): void {
    taskManager.appendOutput(this.taskId, line);
  }

  writeOutputFileOnly(line: string): void {
    taskManager.appendOutputFileOnly(this.taskId, line);
  }

  writeSystemOutput(prefix: string, message: string): void {
    taskManager.appendOutput(this.taskId, `[${prefix}] ${message}`);
  }

  // --- Lifecycle ---

  registerAbort(controller: AbortController): void {
    this.registeredAbortController = controller;
    processRegistry.register({
      taskId: this.taskId,
      abortController: controller,
      registeredAt: Date.now(),
      label: 'provider-session',
    });

    // Wire abort signal to registered callbacks
    const onAbort = () => {
      for (const cb of this.abortCallbacks) {
        try { cb(); } catch { /* swallow */ }
      }
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  }

  unregisterAbort(): void {
    this.registeredAbortController = null;
    processRegistry.unregister(this.taskId);
  }

  isTerminal(): boolean {
    const task = taskManager.getTask(this.taskId);
    return !task || isTerminalStatus(task.status);
  }

  isAlive(): boolean {
    return !this.isTerminal();
  }

  onAborted(callback: () => void): () => void {
    this.abortCallbacks.push(callback);
    return () => {
      this.abortCallbacks = this.abortCallbacks.filter(cb => cb !== callback);
    };
  }

  // --- Provider state ---

  setProviderState(state: Record<string, unknown> | undefined): void {
    taskManager.updateTask(this.taskId, { providerState: state }, { persist: false });
  }

  setSessionId(id: string): void {
    taskManager.updateTask(this.taskId, { sessionId: id } as Partial<TaskState>);
  }

  setProvider(provider: Provider): void {
    taskManager.updateTask(this.taskId, { provider });
  }

  // --- Read-only accessors ---

  getPrompt(): string {
    return taskManager.getTask(this.taskId)?.prompt ?? '';
  }

  getCwd(): string {
    return taskManager.getTask(this.taskId)?.cwd ?? process.cwd();
  }

  getTimeout(): number {
    return taskManager.getTask(this.taskId)?.timeout ?? 1_800_000;
  }

  getModel(): string {
    return taskManager.getTask(this.taskId)?.model ?? 'claude-sonnet-4.6';
  }

  getMode(): AgentMode {
    return taskManager.getTask(this.taskId)?.mode ?? DEFAULT_AGENT_MODE;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TaskHandle for a given task ID.
 * This is the only entry point — providers call this,
 * never constructing TaskHandleImpl directly.
 */
export function createTaskHandle(taskId: string): TaskHandle {
  return new TaskHandleImpl(taskId);
}
