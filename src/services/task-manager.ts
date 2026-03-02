import { generateTaskId, normalizeTaskId } from '../utils/task-id-generator.js';
import { TaskState, TaskStatus, TERMINAL_STATUSES, isTerminalStatus } from '../types.js';
import { saveTasks, loadTasks } from './task-persistence.js';
import { shouldRetryNow, hasExceededMaxRetries } from './retry-queue.js';
import { TASK_STALL_WARN_MS, TASK_TTL_MS } from '../config/timeouts.js';
import { createOutputFile, appendToOutputFile, finalizeOutputFile, getOutputPath, closeAllOutputHandles } from './output-file.js';
import { processRegistry } from './process-registry.js';
import { unlink } from 'fs/promises';

const MAX_TASKS = 100;

/** Legal state transitions - if a transition isn't in this map, it's rejected */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  [TaskStatus.PENDING]: new Set([TaskStatus.WAITING, TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED]),
  [TaskStatus.WAITING]: new Set([TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED]),
  [TaskStatus.RUNNING]: new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMED_OUT, TaskStatus.RATE_LIMITED]),
  [TaskStatus.RATE_LIMITED]: new Set([TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.RUNNING]),
  [TaskStatus.COMPLETED]: new Set([]), // terminal
  [TaskStatus.FAILED]: new Set([]),  // terminal
  [TaskStatus.CANCELLED]: new Set([]),  // terminal
  [TaskStatus.TIMED_OUT]: new Set([]),  // terminal
};

/**
 * Check if adding dependencies would create a circular dependency
 * @param newTaskId - The ID of the task being created
 * @param dependsOn - Array of task IDs this task depends on
 * @param tasks - Map of all existing tasks
 * @returns true if circular dependency would be created
 */
function hasCircularDependency(newTaskId: string, dependsOn: string[], tasks: Map<string, TaskState>): boolean {
  const visited = new Set<string>();
  const toCheck = [...dependsOn];
  
  while (toCheck.length > 0) {
    const depId = toCheck.pop()!;
    const normalizedDepId = normalizeTaskId(depId);
    
    if (normalizedDepId === normalizeTaskId(newTaskId)) {
      return true; // Circular dependency found
    }
    
    if (visited.has(normalizedDepId)) {
      continue;
    }
    visited.add(normalizedDepId);
    
    const depTask = tasks.get(normalizedDepId);
    if (depTask?.dependsOn) {
      toCheck.push(...depTask.dependsOn);
    }
  }
  return false;
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
  return task.session !== undefined && task.status === TaskStatus.RUNNING;
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

  /**
   * Process waiting tasks and start those with satisfied dependencies
   */
  private processWaitingTasks(): void {
    const waitingTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.WAITING);
    
    if (waitingTasks.length === 0) {
      return;
    }

    for (const task of waitingTasks) {
      if (task.status !== TaskStatus.WAITING) continue; // Skip cancelled/terminal tasks

      const result = areDependenciesSatisfied(task, this.tasks);
      
      if (result.satisfied && this.executeCallback) {
        console.error(`[task-manager] Dependencies satisfied for ${task.id}, starting execution`);
        const updated = this.updateTask(task.id, { status: TaskStatus.PENDING });
        if (!updated) {
          console.error(`[task-manager] Task ${task.id} was deleted before it could start`);
          continue;
        }
        this.executeCallback(updated).catch(err => {
          console.error(`[task-manager] Failed to execute task ${task.id}:`, err);
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

    // Check if all dependencies exist
    for (const depId of dependsOn) {
      const normalizedDepId = normalizeTaskId(depId);
      if (!this.tasks.has(normalizedDepId)) {
        return `Dependency task '${depId}' not found`;
      }
    }

    // Check for circular dependencies (only if newTaskId provided)
    if (newTaskId && hasCircularDependency(newTaskId, dependsOn, this.tasks)) {
      return 'Circular dependency detected';
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
    const rateLimitedTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.RATE_LIMITED);
    
    if (rateLimitedTasks.length === 0) {
      return;
    }

    console.error(`[task-manager] Found ${rateLimitedTasks.length} rate-limited task(s)`);

    for (const task of rateLimitedTasks) {
      // Check if max retries exceeded
      if (hasExceededMaxRetries(task)) {
        console.error(`[task-manager] Task ${task.id} exceeded max retries, marking as failed`);
        this.updateTask(task.id, {
          status: TaskStatus.FAILED,
          error: `Max retries (${task.retryInfo?.maxRetries}) exceeded for rate limit`,
          endTime: new Date().toISOString(),
          exitCode: 1,
        });
        continue;
      }

      // Check if ready for retry
      if (shouldRetryNow(task)) {
        console.error(`[task-manager] Auto-retrying task ${task.id} (attempt ${(task.retryInfo?.retryCount ?? 0) + 1})`);
        
        if (this.retryCallback) {
          // Kill old session before spawning retry
          processRegistry.killTask(task.id).catch(() => {});
          try {
            // Spawn replacement task FIRST — only mark original FAILED on success
            const newTaskId = await this.retryCallback(task);
            this.updateTask(task.id, {
              status: TaskStatus.FAILED,
              error: `Auto-retried as new task${newTaskId ? ` ${newTaskId}` : ''} (attempt ${(task.retryInfo?.retryCount ?? 0) + 1}/${task.retryInfo?.maxRetries ?? 6})`,
              endTime: new Date().toISOString(),
              exitCode: 1,
            });
          } catch (err) {
            console.error(`[task-manager] Auto-retry failed for task ${task.id}, keeping RATE_LIMITED:`, err);
            // Don't mark FAILED — task stays RATE_LIMITED for next retry cycle
          }
        } else {
          console.error(`[task-manager] No retry callback registered, task ${task.id} will wait`);
        }
      } else {
        const nextRetry = task.retryInfo?.nextRetryTime;
        const waitMs = nextRetry ? new Date(nextRetry).getTime() - Date.now() : 0;
        const waitMin = Math.ceil(waitMs / 60000);
        console.error(`[task-manager] Task ${task.id} not ready for retry, waiting ${waitMin} more minutes`);
      }
    }

    // Schedule next check based on soonest retry time
    this.scheduleRateLimitCheck();
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

    const nextTimes = Array.from(this.tasks.values())
      .filter(t => t.status === TaskStatus.RATE_LIMITED && t.retryInfo?.nextRetryTime)
      .map(t => new Date(t.retryInfo!.nextRetryTime).getTime())
      .filter(t => Number.isFinite(t));

    if (nextTimes.length === 0) {
      return;
    }

    const nextAt = Math.min(...nextTimes);
    const delayMs = Math.max(0, nextAt - Date.now());

    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = null;
      this.processRateLimitedTasks();
    }, delayMs);
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
    const count = this.tasks.size;
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
    this.scheduleRateLimitCheck();
    this.isClearing = false;
    return count;
  }

  /**
   * Manually trigger retry of a rate-limited task
   * Returns the new task ID on success
   */
  async triggerManualRetry(taskId: string): Promise<{ success: boolean; newTaskId?: string; error?: string }> {
    const normalizedId = normalizeTaskId(taskId);
    const task = this.tasks.get(normalizedId);
    
    if (!task) {
      return { success: false, error: 'Task not found' };
    }
    
    if (task.status !== TaskStatus.RATE_LIMITED) {
      return { success: false, error: `Task is not rate-limited (status: ${task.status})` };
    }
    
    if (!this.retryCallback) {
      return { success: false, error: 'No retry callback registered' };
    }
    
    try {
      // Spawn replacement task FIRST — only mark original FAILED on success  
      const newTaskId = await this.retryCallback(task);
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
            const elapsedMs = task.startTime ? now - new Date(task.startTime).getTime() : 0;
            console.error(`[task-manager] Health check: hard timeout reached for task ${task.id} after ${elapsedMs}ms`);
            // Kill process first, THEN update status
            processRegistry.killTask(task.id).then(() => {
              if (task.session) {
                return Promise.race([
                  task.session.abort(),
                  new Promise<void>((_, r) => setTimeout(() => r(new Error('abort timeout')), 5000)),
                ]).catch(() => { /* swallow */ });
              }
            }).catch(() => { /* swallow */ }).finally(() => {
              this.updateTask(task.id, {
                status: TaskStatus.TIMED_OUT,
                endTime: new Date(now).toISOString(),
                error: `Task timed out after ${task.timeout ?? elapsedMs}ms`,
                timeoutReason: 'hard_timeout',
                timeoutContext: {
                  timeoutMs: task.timeout,
                  elapsedMs,
                  detectedBy: 'health_check',
                },
                session: undefined,
              });
            });
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

    // Check WAITING tasks for timeout
    for (const task of this.tasks.values()) {
      if (task.status !== TaskStatus.WAITING) continue;
      if (task.timeoutAt && now >= new Date(task.timeoutAt).getTime()) {
        this.updateTask(task.id, {
          status: TaskStatus.TIMED_OUT,
          error: 'Task timed out while waiting for dependencies',
          endTime: new Date().toISOString(),
          timeoutReason: 'hard_timeout',
        });
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

  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    let removed = false;

    for (const [id, task] of this.tasks) {
      if (task.status === TaskStatus.COMPLETED ||
          task.status === TaskStatus.FAILED ||
          task.status === TaskStatus.CANCELLED ||
          task.status === TaskStatus.TIMED_OUT) {
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
        .filter(([_, t]) => evictableStatuses.has(t.status))
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

  createTask(prompt: string, cwd?: string, model?: string, options?: { autonomous?: boolean; isResume?: boolean; retryInfo?: import('../types.js').RetryInfo; dependsOn?: string[]; labels?: string[]; provider?: import('../types.js').Provider; fallbackAttempted?: boolean; switchAttempted?: boolean; timeout?: number }): TaskState {
    if (this.isClearing) {
      throw new Error('Cannot create tasks while clearing workspace');
    }
    const id = generateTaskId();
    const normalizedId = normalizeTaskId(id);
    
    // Determine initial status based on dependencies
    let initialStatus = TaskStatus.PENDING;
    const dependsOn = options?.dependsOn?.filter(d => d.trim()) || [];
    const labels = options?.labels?.filter(l => l.trim()) || [];
    
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
      autonomous: options?.autonomous,
      isResume: options?.isResume,
      retryInfo: options?.retryInfo,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
      provider: options?.provider,
      fallbackAttempted: options?.fallbackAttempted,
      switchAttempted: options?.switchAttempted,
      timeout: options?.timeout,
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

  updateTask(id: string, updates: Partial<TaskState>): TaskState | null {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) {
      return null;
    }

    const previousStatus = task.status;

    // Validate state transition before applying
    if (updates.status && updates.status !== task.status) {
      const allowed = VALID_TRANSITIONS[task.status];
      if (allowed && !allowed.has(updates.status)) {
        console.error(`[task-manager] Rejected illegal transition ${task.status} → ${updates.status} for task ${id}`);
        return task; // Return current state, don't apply illegal transition
      }
    }

    // Guard: reject state transitions on already-terminal tasks
    if (updates.status !== undefined && TERMINAL_STATUSES.has(task.status)) {
      // Task is already terminal — don't allow further state changes
      // (e.g., health check timeout arriving after completion)
      console.error(`[task-manager] Rejecting ${task.status}→${updates.status} transition for ${task.id} (already terminal)`);
      return task;
    }

    // Mutate in-place to prevent reference drift with appendOutput.
    // Both appendOutput and updateTask operate on the same Map entry;
    // replacing the object (spread) would cause appendOutput to push
    // to a stale reference that's no longer in the Map.
    Object.assign(task, updates);

    const statusChanged = updates.status !== undefined && updates.status !== previousStatus;
    if (statusChanged && TERMINAL_STATUSES.has(task.status)) {
      // Clear session reference on terminal status (SDK adapter handles actual cleanup)
      task.session = undefined;
      if (!task.endTime) {
        task.endTime = new Date().toISOString();
      }
      // Finalize output file with completion status (async, fire-and-forget)
      if (task.cwd) {
        finalizeOutputFile(task.cwd, task.id, task.status, task.error).catch(() => {});
      }
    }
    // Also clear session reference on RATE_LIMITED transition (session is no longer valid)
    if (task.status === TaskStatus.RATE_LIMITED && statusChanged) {
      task.session = undefined;
    }
    // No need to re-set in Map — object reference is unchanged
    // Flush immediately for terminal transitions to minimize crash window
    if (updates.status && isTerminalStatus(updates.status)) {
      this.persistNow().catch(() => {});
    } else {
      this.schedulePersist('state');
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
    if (updates.status === TaskStatus.FAILED || updates.status === TaskStatus.CANCELLED || updates.status === TaskStatus.TIMED_OUT) {
      this.processWaitingTasks();
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
      const now = new Date().toISOString();
      task.lastOutputAt = now;
      task.lastHeartbeatAt = now;
      if (task.timeoutReason === 'stall') {
        task.timeoutReason = undefined;
        task.timeoutContext = undefined;
      }
      task.output.push(line);
      try { this.outputCallback?.(id, line); } catch {}

      // Write to output file for live monitoring (async, fire-and-forget)
      if (task.cwd) {
        appendToOutputFile(task.cwd, task.id, line).catch(() => {});
      }
      
      if (task.output.length > MAX_OUTPUT_LINES) {
        task.output = task.output.slice(-MAX_OUTPUT_LINES);
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

    // Idempotency guard: terminal statuses are no-ops
    if (task.status === TaskStatus.CANCELLED || task.status === TaskStatus.COMPLETED ||
        task.status === TaskStatus.FAILED || task.status === TaskStatus.TIMED_OUT) {
      return { success: true, alreadyDead: true };
    }

    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING && task.status !== TaskStatus.WAITING && task.status !== TaskStatus.RATE_LIMITED) {
      return { success: false, error: `Task is not cancellable (status: ${task.status})` };
    }

    let alreadyDead = false;

    // Use process registry for proper escalation
    const killed = await processRegistry.killTask(task.id);
    if (!killed && task.session) {
      try {
        await Promise.race([
          task.session.abort(),
          new Promise<void>((_, r) => setTimeout(() => r(new Error('abort timeout')), 5000)),
        ]);
      } catch {
        /* already dead or timed out */
      }
    } else if (!killed && task.status === TaskStatus.RUNNING) {
      // Running but no session and not in registry - already dead
      alreadyDead = true;
    }

    this.updateTask(task.id, {
      status: TaskStatus.CANCELLED,
      endTime: new Date().toISOString(),
      error: alreadyDead ? 'Session had already ended before cancellation' : undefined,
      session: undefined,
    });
    return { success: true, alreadyDead };
  }

  async shutdown(): Promise<void> {
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

    // Kill all tracked processes with SIGTERM→SIGKILL escalation
    await processRegistry.killAll();

    // Close all output file handles
    await closeAllOutputHandles();

    // Final persist before shutdown
    await this.persistNow();
  }
}

export const taskManager = new TaskManager();
