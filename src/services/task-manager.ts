import { generateUniqueTaskId, normalizeTaskId } from '../utils/task-id-generator.js';
import { TaskState, TaskStatus, TERMINAL_STATUSES, isTerminalStatus } from '../types.js';
import { saveTasks, loadTasks } from './task-persistence.js';
import { shouldRetryNow, hasExceededMaxRetries } from './retry-queue.js';
import { TASK_STALL_WARN_MS, TASK_TTL_MS } from '../config/timeouts.js';
import { createOutputFile, appendToOutputFile, finalizeOutputFile, getOutputPath, shutdownOutputFileCleanup } from './output-file.js';
import { processRegistry } from './process-registry.js';
import { unlink } from 'fs/promises';

const MAX_TASKS = 100;
const retryInFlight = new Set<string>();

/** Legal state transitions - if a transition isn't in this map, it's rejected */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  [TaskStatus.PENDING]: new Set([TaskStatus.WAITING, TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED, TaskStatus.TIMED_OUT]),
  [TaskStatus.WAITING]: new Set([TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED, TaskStatus.TIMED_OUT]),
  [TaskStatus.RUNNING]: new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT, TaskStatus.RATE_LIMITED]),
  [TaskStatus.RATE_LIMITED]: new Set([TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.RUNNING, TaskStatus.TIMED_OUT]),
  [TaskStatus.COMPLETED]: new Set([]), // terminal
  [TaskStatus.FAILED]: new Set([]),  // terminal
  [TaskStatus.CANCELLED]: new Set([]),  // terminal
  [TaskStatus.TIMED_OUT]: new Set([]),  // terminal
};

/**
 * Detect circular dependencies in active dependency chains.
 * Completed/terminal tasks are treated as leaf nodes because they cannot block progress.
 *
 * @param startIds - Task IDs to start traversal from
 * @param tasks - Map of all existing tasks
 * @param newTaskId - Optional synthetic task ID to include in graph traversal
 * @param dependsOn - Synthetic dependencies for newTaskId
 * @returns cycle path if found (e.g. a -> b -> a), otherwise null
 */
function findCircularDependencyPath(
  startIds: string[],
  tasks: Map<string, TaskState>,
  newTaskId?: string,
  dependsOn: string[] = [],
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const normalizedNewTaskId = newTaskId ? normalizeTaskId(newTaskId) : null;

  const getDependencies = (taskId: string): string[] => {
    if (normalizedNewTaskId && taskId === normalizedNewTaskId) {
      return dependsOn;
    }
    const task = tasks.get(taskId);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      return [];
    }
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED || task.status === TaskStatus.TIMED_OUT) {
      return [];
    }
    return task.dependsOn;
  };

  const dfs = (taskId: string): string[] | null => {
    const normalizedTaskId = normalizeTaskId(taskId);

    if (visiting.has(normalizedTaskId)) {
      const cycleStart = stack.indexOf(normalizedTaskId);
      return [...stack.slice(cycleStart), normalizedTaskId];
    }
    if (visited.has(normalizedTaskId)) {
      return null;
    }

    visiting.add(normalizedTaskId);
    stack.push(normalizedTaskId);

    for (const depId of getDependencies(normalizedTaskId)) {
      const cyclePath = dfs(depId);
      if (cyclePath) {
        return cyclePath;
      }
    }

    stack.pop();
    visiting.delete(normalizedTaskId);
    visited.add(normalizedTaskId);
    return null;
  };

  for (const startId of startIds) {
    const cyclePath = dfs(startId);
    if (cyclePath) {
      return cyclePath;
    }
  }

  return null;
}

function getTransitionRejectionReason(from: TaskStatus, to: TaskStatus): string | null {
  if (from === to) {
    return null;
  }
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return `Task has unknown current status '${from}'`;
  }
  if (TERMINAL_STATUSES.has(from)) {
    return `Task is already terminal ('${from}') and cannot transition to '${to}'`;
  }
  if (!allowed.has(to)) {
    const allowedTransitions = Array.from(allowed.values());
    return `Illegal status transition '${from}' -> '${to}'. Allowed from '${from}': ${allowedTransitions.length > 0 ? allowedTransitions.join(', ') : 'none'}`;
  }
  return null;
}

/**
 * Check if all dependencies for a task are satisfied (completed successfully)
 */
function areDependenciesSatisfied(task: TaskState, tasks: Map<string, TaskState>): { satisfied: boolean; missing: string[]; failed: string[]; pending: string[] } {
  if (!task.dependsOn || task.dependsOn.length === 0) {
    return { satisfied: true, missing: [], failed: [], pending: [] };
  }
  
  const missing: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  
  for (const depId of task.dependsOn) {
    const normalizedDepId = normalizeTaskId(depId);
    const depTask = tasks.get(normalizedDepId);
    
    if (!depTask) {
      missing.push(depId);
    } else if (depTask.status === TaskStatus.COMPLETED) {
      // Good - dependency completed successfully
    } else if (depTask.status === TaskStatus.FAILED || depTask.status === TaskStatus.CANCELLED || depTask.status === TaskStatus.TIMED_OUT) {
      failed.push(depId);
    } else {
      // PENDING, WAITING, RUNNING, RATE_LIMITED
      pending.push(depId);
    }
  }
  
  const satisfied = missing.length === 0 && failed.length === 0 && pending.length === 0;
  return { satisfied, missing, failed, pending };
}
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 10 * 1000; // Check session health every 10 seconds
const MAX_OUTPUT_LINES = 2000;
// Re-export from types.ts for backward compatibility
export { TERMINAL_STATUSES } from '../types.js';

/**
 * Check if an SDK session is still active
 * Note: With SDK, session liveness is managed by the SDK itself via events
 */
export function isSessionActive(task: TaskState): boolean {
  return task.providerState !== undefined && task.status === TaskStatus.RUNNING;
}


class TaskManager {
  private tasks: Map<string, TaskState> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private rateLimitTimer: NodeJS.Timeout | null = null;
  private currentCwd: string | null = null;
  private persistTimeout: NodeJS.Timeout | null = null;
  private persistDebounceMs = 100;
  private outputPersistDebounceMs = 1000;
  private lastPersistTrigger: 'state' | 'output' = 'state';
  private isClearing = false;
  private isShuttingDown = false;
  private isProcessingRateLimits = false;
  private timingOutTasks: Set<string> = new Set();
  private retryCallback: ((task: TaskState) => Promise<string | undefined>) | null = null;
  private executeCallback: ((task: TaskState) => Promise<void>) | null = null;
  private statusChangeCallback: ((task: TaskState, previousStatus: TaskStatus) => void) | null = null;
  private outputCallback: ((taskId: string, line: string) => void) | null = null;
  private taskCreatedCallback: ((task: TaskState) => void) | null = null;
  private taskDeletedCallback: ((taskId: string) => void) | null = null;

  constructor() {
    // Timers are started lazily in setCwd() after workspace is known
  }

  /**
   * Set the current workspace and load persisted tasks
   * Also triggers auto-retry for rate-limited tasks
   */
  async setCwd(cwd: string): Promise<void> {
    this.currentCwd = cwd;
    const { tasks: loadedTasks, cooldowns } = await loadTasks(cwd);
    
    // Restore cooldown state before processing tasks (so RATE_LIMITED retry uses correct cooldowns)
    if (cooldowns && cooldowns.length > 0) {
      const { accountManager } = await import('./account-manager.js');
      accountManager.importCooldownState(cooldowns);
    }

    // Load tasks into the map
    for (const task of loadedTasks) {
      const normalizedId = normalizeTaskId(task.id);
      this.tasks.set(normalizedId, task);
    }
    
    // Run cleanup on loaded tasks (removes expired ones)
    this.cleanup();
    
    // Add jitter to RATE_LIMITED tasks whose nextRetryTime is in the past
    // to prevent thundering herd when all retry immediately after restart
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.RATE_LIMITED && task.retryInfo) {
        const nextRetry = task.retryInfo.nextRetryTime ? new Date(task.retryInfo.nextRetryTime).getTime() : 0;
        if (nextRetry < Date.now()) {
          task.retryInfo.nextRetryTime = new Date(Date.now() + Math.random() * 60000).toISOString();
        }
      }
    }

    // Process rate-limited tasks for auto-retry
    this.processRateLimitedTasks();

    // Process waiting tasks whose dependencies are already satisfied
    this.processWaitingTasks();

    // Start periodic timers now that we have a workspace
    if (!this.cleanupInterval) this.startCleanup();
    if (!this.healthCheckInterval) this.startHealthCheck();

    // Persist recovered state so restart recovery isn't repeated forever
    if (loadedTasks.length > 0) {
      this.schedulePersist('state');
    }
  }

  /**
   * Register a callback to be called when a rate-limited task should be retried
   * Callback should return the new task ID
   */
  onRetry(callback: (task: TaskState) => Promise<string | undefined>): () => void {
    this.retryCallback = callback;
    this.scheduleRateLimitCheck();
    return () => {
      if (this.retryCallback === callback) this.retryCallback = null;
    };
  }

  /**
   * Register a callback to execute a waiting task when dependencies are satisfied
   */
  onExecute(callback: (task: TaskState) => Promise<void>): () => void {
    this.executeCallback = callback;
    queueMicrotask(() => this.processWaitingTasks());
    return () => {
      if (this.executeCallback === callback) this.executeCallback = null;
    };
  }

  onStatusChange(callback: (task: TaskState, previousStatus: TaskStatus) => void): () => void {
    this.statusChangeCallback = callback;
    return () => {
      if (this.statusChangeCallback === callback) this.statusChangeCallback = null;
    };
  }

  onOutput(callback: (taskId: string, line: string) => void): () => void {
    this.outputCallback = callback;
    return () => {
      if (this.outputCallback === callback) this.outputCallback = null;
    };
  }

  onTaskCreated(callback: (task: TaskState) => void): () => void {
    this.taskCreatedCallback = callback;
    return () => {
      if (this.taskCreatedCallback === callback) this.taskCreatedCallback = null;
    };
  }

  onTaskDeleted(callback: (taskId: string) => void): () => void {
    this.taskDeletedCallback = callback;
    return () => {
      if (this.taskDeletedCallback === callback) this.taskDeletedCallback = null;
    };
  }

  /**
   * Remove all registered listener callbacks to prevent memory leaks.
   */
  removeAllListeners(): void {
    this.retryCallback = null;
    this.executeCallback = null;
    this.statusChangeCallback = null;
    this.outputCallback = null;
    this.taskCreatedCallback = null;
    this.taskDeletedCallback = null;
  }

  private async abortFallbackTask(taskId: string, reason: string): Promise<void> {
    try {
      const { abortClaudeCodeSession } = await import('./claude-code-runner.js');
      abortClaudeCodeSession(taskId, reason);
    } catch {
      /* swallow */
    }
  }

  private async abortAllFallbackTasks(reason: string): Promise<void> {
    try {
      const { abortAllFallbackSessions } = await import('./claude-code-runner.js');
      abortAllFallbackSessions(reason);
    } catch {
      /* swallow */
    }
  }

  private async cleanupSdkBindings(): Promise<void> {
    try {
      const { sdkSessionAdapter } = await import('./sdk-session-adapter.js');
      sdkSessionAdapter.cleanup();
    } catch {
      /* swallow */
    }
  }

  /**
   * Process waiting tasks and start those with satisfied dependencies
   */
  private processWaitingTasks(): void {
    if (this.isShuttingDown || this.isClearing) return;
    const waitingTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.WAITING);
    
    if (waitingTasks.length === 0) {
      return;
    }

    for (const task of waitingTasks) {
      if (task.status !== TaskStatus.WAITING) continue; // Skip cancelled/terminal tasks

      const circularPath = findCircularDependencyPath([task.id], this.tasks, task.id, task.dependsOn || []);
      if (circularPath) {
        this.updateTask(task.id, {
          status: TaskStatus.FAILED,
          error: `Circular dependency deadlock detected: ${circularPath.join(' -> ')}. Remove one dependency in this cycle or force-start one task.`,
          endTime: new Date().toISOString(),
        });
        continue;
      }

      const result = areDependenciesSatisfied(task, this.tasks);
      
      if (result.satisfied && this.executeCallback) {
        console.error(`[task-manager] Dependencies satisfied for ${task.id}, starting execution`);
        const updated = this.updateTask(task.id, { status: TaskStatus.PENDING });
        if (!updated) {
          console.error(`[task-manager] Task ${task.id} was deleted before it could start`);
          continue;
        }
        this.executeCallback(updated).catch(err => {
          console.error(`[task-manager] Failed to execute waiting task ${task.id}:`, err);
          this.updateTask(task.id, { status: TaskStatus.FAILED, error: `Execution failed: ${err instanceof Error ? err.message : String(err)}` });
        });
        continue;
      }

      // All remaining deps failed/cancelled/timed out — no way to satisfy
      if (!result.satisfied && result.pending.length === 0 && result.failed.length > 0) {
        const failedDepIds = result.failed.join(', ');
        this.updateTask(task.id, {
          status: TaskStatus.FAILED,
          error: `Dependencies failed or were cancelled: ${failedDepIds}`,
          endTime: new Date().toISOString(),
        });
        continue;
      }

      // Dependencies are unresolved because required tasks do not exist
      if (!result.satisfied && result.pending.length === 0 && result.failed.length === 0 && result.missing.length > 0) {
        const missingDepIds = result.missing.join(', ');
        this.updateTask(task.id, {
          status: TaskStatus.FAILED,
          error: `Dependencies missing: ${missingDepIds}`,
          endTime: new Date().toISOString(),
        });
        continue;
      }
    }
  }

  /**
   * Validate dependencies for a new task
   * Returns error message if invalid, null if valid
   */
  validateDependencies(dependsOn: string[], newTaskId?: string): string | null {
    if (!dependsOn || dependsOn.length === 0) {
      return null;
    }

    const normalizedDependsOn = dependsOn.map(depId => normalizeTaskId(depId));
    if (new Set(normalizedDependsOn).size !== normalizedDependsOn.length) {
      return 'Duplicate dependency IDs are not allowed; remove duplicates from depends_on';
    }

    if (newTaskId && normalizedDependsOn.includes(normalizeTaskId(newTaskId))) {
      return `Task '${newTaskId}' cannot depend on itself`;
    }

    // Check if all dependencies exist
    for (const depId of dependsOn) {
      const normalizedDepId = normalizeTaskId(depId);
      if (!this.tasks.has(normalizedDepId)) {
        return `Dependency task '${depId}' not found. Use task:///all to list valid task IDs.`;
      }
    }

    const cyclePath = newTaskId
      ? findCircularDependencyPath([newTaskId], this.tasks, newTaskId, dependsOn)
      : findCircularDependencyPath(dependsOn, this.tasks);
    if (cyclePath) {
      return `Circular dependency detected: ${cyclePath.join(' -> ')}. Remove one dependency edge in this cycle.`;
    }

    return null;
  }

  /**
   * Get dependency status info for a task
   */
  getDependencyStatus(taskId: string): { satisfied: boolean; missing: string[]; failed: string[]; pending: string[] } | null {
    const task = this.getTask(taskId);
    if (!task || !task.dependsOn) {
      return null;
    }
    return areDependenciesSatisfied(task, this.tasks);
  }

  /**
   * Force start a waiting task, bypassing failed/missing dependencies
   */
  async forceStartTask(taskId: string): Promise<{ success: boolean; taskId?: string; bypassedDeps?: string[]; error?: string }> {
    const normalizedId = normalizeTaskId(taskId);
    const task = this.tasks.get(normalizedId);
    
    if (!task) {
      return { success: false, error: 'Task not found' };
    }
    
    if (task.status !== TaskStatus.WAITING) {
      return { success: false, error: `Task is not waiting (status: ${task.status})` };
    }
    
    if (!this.executeCallback) {
      return { success: false, error: 'No execute callback registered' };
    }
    
    const bypassedDeps = task.dependsOn || [];

    // Clear dependencies so retries won't re-block (route through updateTask for consistency)
    this.updateTask(task.id, { dependsOn: [] });

    console.error(`[task-manager] Force starting ${task.id}, bypassing deps: ${bypassedDeps.join(', ')}`);

    // Execute the task
    await this.executeCallback(task);
    
    return { 
      success: true, 
      taskId: task.id,
      bypassedDeps,
    };
  }

  /**
   * Process rate-limited tasks and trigger retries for those ready
   */
  private async processRateLimitedTasks(): Promise<void> {
    if (this.isProcessingRateLimits) {
      return;
    }
    this.isProcessingRateLimits = true;

    try {
      const rateLimitedTasks = Array.from(this.tasks.values())
        .filter(t => t.status === TaskStatus.RATE_LIMITED);
      
      if (rateLimitedTasks.length === 0) {
        return;
      }

      console.error(`[task-manager] Found ${rateLimitedTasks.length} rate-limited task(s)`);

      for (const task of rateLimitedTasks) {
        // Re-fetch to avoid stale snapshot (CC-013)
        const freshTask = this.getTask(task.id);
        if (!freshTask || freshTask.status !== TaskStatus.RATE_LIMITED) continue;

        // Check if max retries exceeded
        if (hasExceededMaxRetries(freshTask)) {
          console.error(`[task-manager] Task ${freshTask.id} exceeded max retries, marking as failed`);
          this.updateTask(freshTask.id, {
            status: TaskStatus.FAILED,
            error: `Max retries (${freshTask.retryInfo?.maxRetries}) exceeded for rate limit`,
            endTime: new Date().toISOString(),
            exitCode: 1,
          });
          continue;
        }

        // Check if ready for retry
        if (shouldRetryNow(freshTask)) {
          console.error(`[task-manager] Auto-retrying task ${freshTask.id} (attempt ${(freshTask.retryInfo?.retryCount ?? 0) + 1})`);
          
          if (this.retryCallback) {
            if (retryInFlight.has(freshTask.id)) continue;
            retryInFlight.add(freshTask.id);
            // Kill old session before spawning retry
            try {
              await processRegistry.killTask(freshTask.id);
            } catch {
              /* best effort */
            }
            await this.bestEffortUnbind(freshTask.id);
            try {
              // Spawn replacement task FIRST — only mark original FAILED on success
              const newTaskId = await this.retryCallback(freshTask);

              // Guard: task may have been cancelled/finished while retry callback awaited
              const latestTask = this.getTask(freshTask.id);
              if (!latestTask || isTerminalStatus(latestTask.status)) {
                // If user cancelled during retry spawn, best-effort cancel the replacement task too
                if (latestTask?.status === TaskStatus.CANCELLED && newTaskId) {
                  await this.cancelTask(newTaskId).catch(() => {});
                }
                continue;
              }

              this.updateTask(freshTask.id, {
                status: TaskStatus.FAILED,
                error: `Auto-retried as new task${newTaskId ? ` ${newTaskId}` : ''} (attempt ${(freshTask.retryInfo?.retryCount ?? 0) + 1}/${freshTask.retryInfo?.maxRetries ?? 6})`,
                endTime: new Date().toISOString(),
                exitCode: 1,
              });
            } catch (err) {
              const retryInfo = freshTask.retryInfo;
              this.updateTask(freshTask.id, {
                retryInfo: {
                  reason: retryInfo?.reason ?? 'Auto-retry callback failed',
                  retryCount: retryInfo?.retryCount ?? 0,
                  maxRetries: retryInfo?.maxRetries ?? 6,
                  nextRetryTime: new Date(Date.now() + 60_000).toISOString(),
                },
              });
              console.error(`[task-manager] Auto-retry failed for ${freshTask.id}; backing off 60s: ${err instanceof Error ? err.message : String(err)}`);
              // Don't mark FAILED — task stays RATE_LIMITED for next retry cycle
            } finally {
              retryInFlight.delete(freshTask.id);
            }
          } else {
            console.error(`[task-manager] No retry callback registered, task ${freshTask.id} will wait`);
          }
        } else {
          const nextRetry = freshTask.retryInfo?.nextRetryTime;
          const waitMs = nextRetry ? new Date(nextRetry).getTime() - Date.now() : 0;
          const waitMin = Math.ceil(waitMs / 60000);
          console.error(`[task-manager] Task ${freshTask.id} not ready for retry, waiting ${waitMin} more minutes`);
        }
      }

    } finally {
      this.isProcessingRateLimits = false;
      this.scheduleRateLimitCheck();
    }
  }

  /**
   * Schedule the next rate-limit retry check based on earliest nextRetryTime.
   */
  private scheduleRateLimitCheck(): void {
    if (this.rateLimitTimer) {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    if (!this.retryCallback) {
      return;
    }

    const rateLimitedTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.RATE_LIMITED);

    const hasImmediateRetryTasks = rateLimitedTasks.some(t => !t.retryInfo?.nextRetryTime);

    const nextTimes = rateLimitedTasks
      .filter(t => t.retryInfo?.nextRetryTime)
      .map(t => new Date(t.retryInfo!.nextRetryTime).getTime())
      .filter(t => Number.isFinite(t));

    if (hasImmediateRetryTasks) {
      this.rateLimitTimer = setTimeout(() => {
        this.rateLimitTimer = null;
        this.processRateLimitedTasks();
      }, 0);
      this.rateLimitTimer.unref();
      return;
    }

    if (nextTimes.length === 0) {
      return;
    }

    const nextAt = Math.min(...nextTimes);
    const delayMs = Math.max(0, nextAt - Date.now());

    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = null;
      this.processRateLimitedTasks();
    }, delayMs);
    this.rateLimitTimer.unref();
  }

  /**
   * Get all rate-limited tasks
   */
  getRateLimitedTasks(): TaskState[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.RATE_LIMITED);
  }

  /**
   * Expedite all rate-limited tasks by moving their next retry time up.
   * Called after a successful Copilot account switch so stalled tasks benefit.
   * Tasks are staggered to avoid thundering herd.
   */
  expediteRateLimitedTasks(baseDelayMs: number = 5000): void {
    const rateLimitedTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.RATE_LIMITED && t.retryInfo);

    if (rateLimitedTasks.length === 0) {
      return;
    }

    console.error(`[task-manager] Expediting ${rateLimitedTasks.length} rate-limited task(s) after account switch`);

    let delay = baseDelayMs;
    for (const task of rateLimitedTasks) {
      if (task.retryInfo) {
        this.updateTask(task.id, {
          retryInfo: {
            ...task.retryInfo,
            nextRetryTime: new Date(Date.now() + delay).toISOString(),
          },
        });
        delay += 2000; // Stagger by 2 seconds per task
      }
    }

    // Schedule retry processing based on updated nextRetryTime
    this.scheduleRateLimitCheck();
  }

  /**
   * Clear all tasks from memory (used by clear_tasks tool)
   * Note: With SDK, sessions are managed by sdkSessionAdapter which handles cleanup
   */
  async clearAllTasks(): Promise<number> {
    this.isClearing = true;
    try {
      const count = this.tasks.size;
      const clearReason = 'Tasks cleared by user';

      await this.abortAllFallbackTasks(clearReason);
      await this.cleanupSdkBindings();

      for (const task of this.tasks.values()) {
        const session = task.providerState as { abort?: () => Promise<void> } | undefined;
        if (!session?.abort) continue;
        try {
          await Promise.race([
            session.abort(),
            new Promise<void>((_, r) => setTimeout(() => r(new Error('abort timeout')), 5000)),
          ]);
        } catch {
          /* swallow */
        }
      }

      await processRegistry.killAll();
      if (this.taskDeletedCallback) {
        for (const id of this.tasks.keys()) {
          try { this.taskDeletedCallback(id); } catch {}
        }
      }
      for (const task of this.tasks.values()) {
        this.deleteOutputFile(task);
      }
      this.tasks.clear();
      // Persist empty state immediately so cleared tasks don't reappear on restart
      await this.persistNow();
      this.scheduleRateLimitCheck();
      return count;
    } finally {
      this.isClearing = false;
    }
  }

  /**
   * Manually trigger retry of a rate-limited task
   * Returns the new task ID on success
   */
  async triggerManualRetry(taskId: string): Promise<{ success: boolean; newTaskId?: string; error?: string }> {
    const normalizedId = normalizeTaskId(taskId);
    if (retryInFlight.has(normalizedId)) {
      return { success: false, error: 'Retry already in progress for this task' };
    }
    retryInFlight.add(normalizedId);
    const task = this.tasks.get(normalizedId);
    
    if (!task) {
      retryInFlight.delete(normalizedId);
      return { success: false, error: 'Task not found' };
    }
    
    if (task.status !== TaskStatus.RATE_LIMITED) {
      retryInFlight.delete(normalizedId);
      return { success: false, error: `Task is not rate-limited (status: ${task.status})` };
    }
    
    if (!this.retryCallback) {
      retryInFlight.delete(normalizedId);
      return { success: false, error: 'No retry callback registered' };
    }
    
    try {
      // Spawn replacement task FIRST — only mark original FAILED on success
      const newTaskId = await this.retryCallback(task);

      // Guard: task may have been cancelled/finished while retry callback awaited
      const latestTask = this.getTask(task.id);
      if (!latestTask || isTerminalStatus(latestTask.status)) {
        if (latestTask?.status === TaskStatus.CANCELLED && newTaskId) {
          await this.cancelTask(newTaskId).catch(() => {});
        }
        return { success: false, error: `Task became ${latestTask?.status ?? 'deleted'} during retry` };
      }

      this.updateTask(task.id, {
        status: TaskStatus.FAILED,
        error: `Manually retried as ${newTaskId || 'new task'} (attempt ${(task.retryInfo?.retryCount ?? 0) + 1}/${task.retryInfo?.maxRetries ?? 6})`,
        endTime: new Date().toISOString(),
        exitCode: 1,
      });
      return { 
        success: true, 
        newTaskId: newTaskId || 'unknown',
      };
    } catch (err) {
      return { success: false, error: `Retry spawn failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      retryInFlight.delete(normalizedId);
    }
  }

  /**
   * Persist tasks to disk (debounced)
   */
  private schedulePersist(trigger: 'state' | 'output' = 'state'): void {
    if (!this.currentCwd) {
      return;
    }

    // Use shorter debounce if state change, longer only for consecutive output-only
    const debounceMs = (trigger === 'output' && this.lastPersistTrigger === 'output' && !this.persistTimeout)
      ? this.outputPersistDebounceMs
      : this.persistDebounceMs;

    // If there's already a pending persist with shorter debounce, don't extend it
    if (this.persistTimeout && trigger === 'output' && this.lastPersistTrigger === 'state') {
      return; // State persist is already scheduled with shorter debounce
    }

    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
    }

    this.lastPersistTrigger = trigger;

    this.persistTimeout = setTimeout(() => {
      this.persistTimeout = null;
      this.persistNow().catch(() => {});
    }, debounceMs);
    this.persistTimeout.unref();
  }

  /**
   * Persist tasks immediately
   */
  private async persistNow(): Promise<void> {
    if (!this.currentCwd) {
      return;
    }
    const tasks = Array.from(this.tasks.values());
    const { accountManager } = await import('./account-manager.js');
    const cooldowns = accountManager.exportCooldownState();
    const ok = await saveTasks(this.currentCwd, tasks, cooldowns.length > 0 ? cooldowns : undefined);
    if (!ok) {
      console.error(`[task-manager] Persist failed — ${tasks.length} task(s) may be lost if server crashes`);
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /**
   * Start periodic health check for running sessions
   * With SDK, this primarily monitors for stalled sessions
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkSessionHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
    this.healthCheckInterval.unref();
  }

  /**
   * Check all RUNNING tasks to verify their sessions are healthy
   * SDK manages session lifecycle, so we mainly check for stalls
   */
  private checkSessionHealth(): void {
    const now = Date.now();
    
    const snapshot = Array.from(this.tasks.values());
    for (const task of snapshot) {
      if (task.status === TaskStatus.RUNNING) {
        const lastHeartbeat = task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).getTime() : 0;
        if (now - lastHeartbeat >= HEALTH_CHECK_INTERVAL_MS) {
          this.updateTask(task.id, { lastHeartbeatAt: new Date(now).toISOString() });
        }

        // Enforce hard timeout — session.send() doesn't have a built-in timeout,
        // so the health check is the enforcement mechanism.
        if (task.timeoutAt) {
          const timeoutAt = new Date(task.timeoutAt).getTime();
          if (now >= timeoutAt) {
            if (this.timingOutTasks.has(task.id)) {
              continue;
            }

            const elapsedMs = task.startTime ? now - new Date(task.startTime).getTime() : 0;
            const taskId = task.id;
            const timeoutMs = task.timeout;
            const session = task.providerState as { abort?: () => Promise<void> } | undefined;
            this.timingOutTasks.add(taskId);
            console.error(`[task-manager] Health check: hard timeout reached for task ${taskId} after ${elapsedMs}ms`);

            void (async () => {
              try {
                let killed = false;
                try {
                  killed = await processRegistry.killTask(taskId);
                } catch {
                  /* swallow */
                }

                if (!killed && session?.abort) {
                  try {
                    await Promise.race([
                      session.abort(),
                      new Promise<void>((_, r) => setTimeout(() => r(new Error('abort timeout')), 5000)),
                    ]);
                  } catch {
                    /* swallow */
                  }
                }

                await this.abortFallbackTask(taskId, `Task timed out after ${timeoutMs ?? elapsedMs}ms`);

                // CC-006: The adapter may have already transitioned the task to a terminal
                // status via its own error/shutdown handler. Re-check before applying TIMED_OUT
                // to avoid a rejected transition. Double-signaling is expected and harmless.
                const latestTask = this.getTask(taskId);
                if (this.isClearing || this.isShuttingDown || !latestTask || isTerminalStatus(latestTask.status)) {
                  return;
                }
                this.updateTask(taskId, {
                  status: TaskStatus.TIMED_OUT,
                  endTime: new Date().toISOString(),
                  error: `Task timed out after ${timeoutMs ?? elapsedMs}ms`,
                  timeoutReason: 'hard_timeout',
                  timeoutContext: {
                    timeoutMs,
                    elapsedMs,
                    detectedBy: 'health_check',
                  },
                  providerState: undefined,
                });
              } finally {
                this.timingOutTasks.delete(taskId);
              }
            })();
            continue;
          }
        }
        
        // Check for stalled sessions (no output for extended period)
        if (task.lastOutputAt) {
          const lastOutputAgeMs = now - new Date(task.lastOutputAt).getTime();
          if (lastOutputAgeMs >= TASK_STALL_WARN_MS && task.timeoutReason !== 'stall') {
            console.error(`[task-manager] Health check: session stall detected for task ${task.id}`);
            this.updateTask(task.id, {
              timeoutReason: 'stall',
              timeoutContext: {
                lastOutputAt: task.lastOutputAt,
                lastOutputAgeMs,
                lastHeartbeatAt: task.lastHeartbeatAt,
                sessionAlive: isSessionActive(task),
                detectedBy: 'health_check',
              },
            });
          }
        }
      }
    }

    // Check WAITING, PENDING, and RATE_LIMITED tasks for timeout
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.PENDING && task.timeoutAt && now >= new Date(task.timeoutAt).getTime()) {
        this.updateTask(task.id, {
          status: TaskStatus.TIMED_OUT,
          error: 'Task timed out while pending',
          endTime: new Date().toISOString(),
          timeoutReason: 'hard_timeout',
          timeoutContext: { detectedBy: 'health_check' },
        });
        void this.abortFallbackTask(task.id, 'Task timed out while pending');
        continue;
      }
      if (task.status === TaskStatus.RATE_LIMITED && task.timeoutAt && now >= new Date(task.timeoutAt).getTime()) {
        this.updateTask(task.id, {
          status: TaskStatus.TIMED_OUT,
          error: 'Task timed out while rate-limited',
          endTime: new Date().toISOString(),
          timeoutReason: 'hard_timeout',
          timeoutContext: { detectedBy: 'health_check' },
        });
        void this.abortFallbackTask(task.id, 'Task timed out while rate-limited');
        continue;
      }
      if (task.status !== TaskStatus.WAITING) continue;
      if (task.timeoutAt && now >= new Date(task.timeoutAt).getTime()) {
        this.updateTask(task.id, {
          status: TaskStatus.TIMED_OUT,
          error: 'Task timed out while waiting for dependencies',
          endTime: new Date().toISOString(),
          timeoutReason: 'hard_timeout',
        });
        void this.abortFallbackTask(task.id, 'Task timed out while waiting for dependencies');
      }
    }
  }


  /**
   * Delete output file for a task (fire-and-forget)
   */
  private deleteOutputFile(task: TaskState): void {
    if (task.cwd && task.id) {
      const outputPath = getOutputPath(task.cwd, task.id);
      unlink(outputPath).catch(() => {
        // Ignore - file may not exist or already deleted
      });
    }
  }

  private async bestEffortUnbind(taskId: string): Promise<void> {
    try {
      const { sdkSessionAdapter } = await import('./sdk-session-adapter.js');
      sdkSessionAdapter.unbind(taskId);
    } catch {
      // Best-effort cleanup only.
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    let removed = false;

    // Build set of task IDs referenced as deps by non-terminal tasks (SM-009)
    const referencedDeps = new Set<string>();
    for (const t of this.tasks.values()) {
      if (t.dependsOn && !isTerminalStatus(t.status)) {
        for (const depId of t.dependsOn) {
          referencedDeps.add(normalizeTaskId(depId));
        }
      }
    }

    for (const [id, task] of this.tasks) {
      if (task.status === TaskStatus.COMPLETED ||
          task.status === TaskStatus.FAILED ||
          task.status === TaskStatus.CANCELLED ||
          task.status === TaskStatus.TIMED_OUT) {
        if (referencedDeps.has(id)) continue; // Don't evict tasks referenced as deps
        const endTime = task.endTime ? new Date(task.endTime).getTime() : 0;
        if (now - endTime > TASK_TTL_MS) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      const task = this.tasks.get(id);
      if (task) this.deleteOutputFile(task);
      try { this.taskDeletedCallback?.(id); } catch {}
      this.tasks.delete(id);
      removed = true;
    }

    if (this.tasks.size > MAX_TASKS) {
      const evictableStatuses = new Set([
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.CANCELLED,
        TaskStatus.TIMED_OUT,
      ]);
      const sorted = Array.from(this.tasks.entries())
        .filter(([_, t]) => evictableStatuses.has(t.status) && !referencedDeps.has(_))
        .sort((a, b) => new Date(a[1].startTime).getTime() - new Date(b[1].startTime).getTime());

      const toRemove = sorted.slice(0, this.tasks.size - MAX_TASKS);
      for (const [id] of toRemove) {
        const task = this.tasks.get(id);
        if (task) this.deleteOutputFile(task);
        try { this.taskDeletedCallback?.(id); } catch {}
        this.tasks.delete(id);
        removed = true;
      }
    }

    if (removed) {
      this.schedulePersist('state');
      this.scheduleRateLimitCheck();
    }
  }

  createTask(prompt: string, cwd?: string, model?: string, options?: { isResume?: boolean; retryInfo?: import('../types.js').RetryInfo; dependsOn?: string[]; labels?: string[]; provider?: import('../types.js').Provider; fallbackCount?: number; switchAttempted?: boolean; timeout?: number; mode?: import('../types.js').AgentMode; taskType?: string }): TaskState {
    if (this.isClearing) {
      throw new Error('Cannot create tasks while clearing workspace');
    }
    if (this.tasks.size >= MAX_TASKS) {
      this.cleanup();
      if (this.tasks.size >= MAX_TASKS) {
        throw new Error(`Task capacity reached (${MAX_TASKS}); no evictable terminal tasks available`);
      }
    }
    const id = generateUniqueTaskId(new Set(this.tasks.keys()));
    const normalizedId = normalizeTaskId(id);
    
    // Determine initial status based on dependencies
    let initialStatus = TaskStatus.PENDING;
    const dependsOn = options?.dependsOn?.filter(d => d.trim()) || [];
    const labels = options?.labels?.filter(l => l.trim()) || [];

    const depError = this.validateDependencies(dependsOn, id);
    if (depError) {
      throw new Error(`Cannot create task '${id}': ${depError}`);
    }
    
    if (dependsOn.length > 0) {
      // Check if all dependencies are already completed
      const { satisfied } = areDependenciesSatisfied({ dependsOn } as TaskState, this.tasks);
      initialStatus = satisfied ? TaskStatus.PENDING : TaskStatus.WAITING;
    }
    
    const startTime = new Date().toISOString();
    // Eagerly construct the expected output path so callers can reference it immediately.
    // Actual file creation is async fire-and-forget.
    const outputFilePath = cwd ? getOutputPath(cwd, id) : null;
    if (cwd) {
      createOutputFile(cwd, id).catch(() => {});
    }
    
    const task: TaskState = {
      id,
      status: initialStatus,
      prompt,
      output: [],
      startTime,
      lastHeartbeatAt: startTime,
      cwd,
      model,
      taskType: options?.taskType,
      isResume: options?.isResume,
      retryInfo: options?.retryInfo,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
      provider: options?.provider,
      fallbackCount: options?.fallbackCount,
      switchAttempted: options?.switchAttempted,
      timeout: options?.timeout,
      mode: options?.mode,
      outputFilePath: outputFilePath || undefined,
    };
    this.tasks.set(normalizedId, task);
    this.schedulePersist('state');
    try { this.taskCreatedCallback?.(task); } catch {}
    return task;
  }

  getTask(id: string): TaskState | null {
    const normalizedId = normalizeTaskId(id);
    return this.tasks.get(normalizedId) || null;
  }

  updateTask(id: string, updates: Partial<TaskState>, options?: { persist?: boolean }): TaskState | null {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) {
      return null;
    }

    const previousStatus = task.status;

    // Validate state transition before applying
    if (updates.status && updates.status !== task.status) {
      const transitionError = getTransitionRejectionReason(task.status, updates.status);
      if (transitionError) {
        console.error(`[task-manager] ${transitionError} for task '${task.id}'. Update ignored; refresh task state before retrying.`);
        return task; // Return current state, don't apply illegal transition
      }
    }

    if (updates.dependsOn && updates.dependsOn.length > 0) {
      const dependencyError = this.validateDependencies(updates.dependsOn, task.id);
      if (dependencyError) {
        console.error(`[task-manager] Invalid dependency update for task '${task.id}': ${dependencyError}. Update ignored.`);
        return task;
      }
    }

    if (isTerminalStatus(task.status) && !updates.status) {
      const allowedPostTerminal = ['completionMetrics', 'sessionMetrics'];
      const updateKeys = Object.keys(updates);
      const disallowed = updateKeys.filter(k => !allowedPostTerminal.includes(k));
      if (disallowed.length > 0) {
        return task; // silently reject non-whitelisted mutations on terminal tasks
      }
    }

    // Mutate in-place to prevent reference drift with appendOutput.
    // Both appendOutput and updateTask operate on the same Map entry;
    // replacing the object (spread) would cause appendOutput to push
    // to a stale reference that's no longer in the Map.
    Object.assign(task, updates);

    const statusChanged = updates.status !== undefined && updates.status !== previousStatus;
    if (statusChanged && TERMINAL_STATUSES.has(task.status)) {
      // Clear provider state reference on terminal status (adapter handles actual cleanup)
      task.providerState = undefined;
      if (!task.endTime) {
        task.endTime = new Date().toISOString();
      }
      // Finalize output file with completion status (async, fire-and-forget)
      if (task.cwd) {
        finalizeOutputFile(task.cwd, task.id, task.status, task.error).catch(() => {});
      }
    }
    // Also clear provider state on RATE_LIMITED transition (session is no longer valid)
    if (task.status === TaskStatus.RATE_LIMITED && statusChanged) {
      task.providerState = undefined;
    }
    // No need to re-set in Map — object reference is unchanged
    const shouldPersist = options?.persist !== false || updates.status !== undefined;
    if (shouldPersist) {
      // Flush immediately for terminal and critical transitions to minimize crash window
      if (updates.status && isTerminalStatus(updates.status)) {
        this.persistNow().catch(err => {
          console.error(`[task-manager] Failed to persist terminal state for ${id}:`, err);
        });
      } else if (updates.status === TaskStatus.RUNNING && previousStatus === TaskStatus.PENDING) {
        this.persistNow().catch(err => {
          console.error(`[task-manager] Failed to persist RUNNING state for ${id}:`, err);
        });
      } else {
        this.schedulePersist('state');
      }
    }

    // Fire status change callback
    if (statusChanged) {
      try { this.statusChangeCallback?.(task, previousStatus); } catch {}
    }

    if (statusChanged) {
      if (task.status === TaskStatus.RATE_LIMITED || previousStatus === TaskStatus.RATE_LIMITED) {
        this.scheduleRateLimitCheck();
      }
    }

    // When a task completes, check if any waiting tasks can now run
    if (updates.status === TaskStatus.COMPLETED && previousStatus !== TaskStatus.COMPLETED) {
      queueMicrotask(() => this.processWaitingTasks());
    }

    // When a task fails/cancels/times out, cascade to waiting dependents
    // Use queueMicrotask to batch dependency checks and prevent unbounded
    // synchronous recursion when cascading failures propagate through chains.
    if (updates.status === TaskStatus.FAILED || updates.status === TaskStatus.CANCELLED || updates.status === TaskStatus.TIMED_OUT) {
      queueMicrotask(() => this.processWaitingTasks());
    }

    return task;
  }

  /**
   * Write to output file only — skips in-memory array and callbacks.
   * Use for verbose debug data (reasoning, internal events) that should be
   * available in the file for debugging but not waste tokens in MCP resources.
   */
  appendOutputFileOnly(id: string, line: string): void {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (task?.cwd) {
      appendToOutputFile(task.cwd, task.id, line).catch(() => {});
    }
  }

  appendOutput(id: string, line: string): void {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (task) {
      if (isTerminalStatus(task.status)) {
        // Still write to disk for forensics, but don't mutate in-memory state
        if (task.cwd) appendToOutputFile(task.cwd, task.id, line).catch(() => {});
        return;
      }
      const now = new Date().toISOString();
      task.lastOutputAt = now;
      task.lastHeartbeatAt = now;
      if (task.timeoutReason === 'stall') {
        task.timeoutReason = undefined;
        task.timeoutContext = undefined;
      }
      task.output.push(line);
      
      if (task.output.length > MAX_OUTPUT_LINES) {
        task.output.splice(0, task.output.length - MAX_OUTPUT_LINES);
      }

      // Update cached stats incrementally
      if (!task.cachedStats) {
        task.cachedStats = { round: 0, totalMessages: 0 };
      }
      if (line.startsWith('--- Turn ') || line.includes('[assistant] Message complete') || line.includes('[turn]')) {
        task.cachedStats.round++;
        task.cachedStats.totalMessages++;
      }
      if (line.includes('[user]') || line.includes('[prompt]') || line.includes('Sending prompt:')) {
        const msgMatch = line.match(/(?:\[user\]|\[prompt\]|Sending prompt:)\s*(.+)/);
        if (msgMatch) {
          task.cachedStats.lastUserMessage = msgMatch[1].slice(0, 100) + (msgMatch[1].length > 100 ? '...' : '');
          task.cachedStats.totalMessages++;
        }
      }
      if (line.includes('[tool] Starting:')) {
        task.cachedStats.totalMessages++;
      }

      try { this.outputCallback?.(id, line); } catch {}

      // Write to output file for live monitoring (async, fire-and-forget)
      if (task.cwd) {
        appendToOutputFile(task.cwd, task.id, line).catch(() => {});
      }
      
      if (!task.sessionId) {
        const sessionMatch = line.match(/(?:Session ID:|session[_-]?id[=:]?)\s*([a-zA-Z0-9_-]+)/i);
        if (sessionMatch) {
          task.sessionId = sessionMatch[1];
          this.schedulePersist('state');
          return;
        }
      }
      
      this.schedulePersist('output');
    }
  }

  getAllTasks(statusFilter?: TaskStatus): TaskState[] {
    const tasks = Array.from(this.tasks.values());
    if (statusFilter) {
      return tasks.filter(t => t.status === statusFilter);
    }
    return tasks;
  }

  async cancelTask(id: string): Promise<{ success: boolean; alreadyDead?: boolean; error?: string }> {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    const getCancellationResult = (): { success: boolean; alreadyDead?: boolean; error?: string } => {
      const latestTask = this.tasks.get(normalizedId);
      if (!latestTask) {
        return { success: false, error: 'Task not found' };
      }
      if (latestTask.status === TaskStatus.CANCELLED) {
        return { success: true };
      }
      if (isTerminalStatus(latestTask.status)) {
        return { success: true, alreadyDead: true };
      }
      return { success: false, error: `Task cancellation did not complete (status: ${latestTask.status})` };
    };

    // Idempotency guard: terminal statuses are no-ops
    if (task.status === TaskStatus.CANCELLED || task.status === TaskStatus.COMPLETED ||
        task.status === TaskStatus.FAILED || task.status === TaskStatus.TIMED_OUT) {
      return { success: true, alreadyDead: true };
    }

    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING && task.status !== TaskStatus.WAITING && task.status !== TaskStatus.RATE_LIMITED) {
      return { success: false, error: `Task is not cancellable (status: ${task.status})` };
    }

    // For non-running tasks, flip to CANCELLED first to block async starters (setImmediate/retry timers)
    if (task.status !== TaskStatus.RUNNING) {
      this.updateTask(task.id, {
        status: TaskStatus.CANCELLED,
        endTime: new Date().toISOString(),
        providerState: undefined,
      });
      // Best-effort cleanup in case any process/session is still registered
      processRegistry.killTask(task.id).catch(() => {});
      await this.abortFallbackTask(task.id, 'Task cancelled by user');
      return getCancellationResult();
    }

    let alreadyDead = false;

    // Use process registry for proper escalation
    const killed = await processRegistry.killTask(task.id);
    const cancelSession = task.providerState as { abort?: () => Promise<void> } | undefined;
    if (!killed && cancelSession?.abort) {
      try {
        await Promise.race([
          cancelSession.abort(),
          new Promise<void>((_, r) => setTimeout(() => r(new Error('abort timeout')), 5000)),
        ]);
      } catch {
        /* already dead or timed out */
      }
    } else if (!killed && task.status === TaskStatus.RUNNING) {
      // Running but no session and not in registry - already dead
      alreadyDead = true;
    }
    await this.abortFallbackTask(task.id, 'Task cancelled by user');
    await this.bestEffortUnbind(task.id);

    // Guard: task may have reached terminal state while cancellation awaited kill/abort
    const latestTask = this.tasks.get(normalizedId);
    if (!latestTask) {
      return { success: false, error: 'Task not found' };
    }
    if (isTerminalStatus(latestTask.status)) {
      return getCancellationResult();
    }

    this.updateTask(latestTask.id, {
      status: TaskStatus.CANCELLED,
      endTime: new Date().toISOString(),
      error: alreadyDead ? 'Session had already ended before cancellation' : undefined,
      providerState: undefined,
    });
    const result = getCancellationResult();
    if (result.success && result.alreadyDead === undefined && alreadyDead) {
      return { success: true, alreadyDead: true };
    }
    return result;
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }

    if (this.rateLimitTimer) {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    // Remove all listener callbacks
    this.removeAllListeners();

    await this.abortAllFallbackTasks('Server shutdown');
    await this.cleanupSdkBindings();

    // Kill all tracked processes with SIGTERM→SIGKILL escalation
    await processRegistry.killAll();

    // Close all output file handles
    await shutdownOutputFileCleanup();

    // Final persist before shutdown (with single retry)
    try {
      await this.persistNow();
    } catch (err) {
      console.error('[task-manager] Persist failed during shutdown, retrying...', err);
      try { await this.persistNow(); } catch { console.error('[task-manager] Final persist also failed — state may be stale'); }
    }
  }
}

export const taskManager = new TaskManager();
