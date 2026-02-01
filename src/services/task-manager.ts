import { generateTaskId, normalizeTaskId } from '../utils/task-id-generator.js';
import { TaskState, TaskStatus } from '../types.js';
import { saveTasks, loadTasks } from './task-persistence.js';
import { shouldRetryNow, hasExceededMaxRetries } from './retry-queue.js';
import { TASK_STALL_WARN_MS } from '../config/timeouts.js';

const MAX_TASKS = 100;

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
    } else if (depTask.status === TaskStatus.FAILED || depTask.status === TaskStatus.CANCELLED) {
      failed.push(depId);
    } else {
      // PENDING, WAITING, RUNNING, RATE_LIMITED
      pending.push(depId);
    }
  }
  
  const satisfied = missing.length === 0 && failed.length === 0 && pending.length === 0;
  return { satisfied, missing, failed, pending };
}
const TASK_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 1000; // Check process health every 5 seconds
const MAX_OUTPUT_LINES = 2000;

/**
 * Check if a process is actually alive using signal 0
 */
function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

class TaskManager {
  private tasks: Map<string, TaskState> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private currentCwd: string | null = null;
  private persistTimeout: NodeJS.Timeout | null = null;
  private persistDebounceMs = 100;
  private outputPersistDebounceMs = 1000;
  private lastPersistTrigger: 'state' | 'output' = 'state';
  private retryCallback: ((task: TaskState) => Promise<string | undefined>) | null = null;
  private executeCallback: ((task: TaskState) => Promise<void>) | null = null;

  constructor() {
    this.startCleanup();
    this.startHealthCheck();
  }

  /**
   * Set the current workspace and load persisted tasks
   * Also triggers auto-retry for rate-limited tasks
   */
  setCwd(cwd: string): void {
    this.currentCwd = cwd;
    const loadedTasks = loadTasks(cwd);
    
    // Load tasks into the map
    for (const task of loadedTasks) {
      const normalizedId = normalizeTaskId(task.id);
      this.tasks.set(normalizedId, task);
    }
    
    // Run cleanup on loaded tasks (removes expired ones)
    this.cleanup();
    
    // Process rate-limited tasks for auto-retry
    this.processRateLimitedTasks();
  }

  /**
   * Register a callback to be called when a rate-limited task should be retried
   * Callback should return the new task ID
   */
  onRetry(callback: (task: TaskState) => Promise<string | undefined>): void {
    this.retryCallback = callback;
  }

  /**
   * Register a callback to execute a waiting task when dependencies are satisfied
   */
  onExecute(callback: (task: TaskState) => Promise<void>): void {
    this.executeCallback = callback;
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
      const { satisfied } = areDependenciesSatisfied(task, this.tasks);
      
      if (satisfied && this.executeCallback) {
        console.error(`[task-manager] Dependencies satisfied for ${task.id}, starting execution`);
        this.executeCallback(task).catch(err => {
          console.error(`[task-manager] Failed to execute task ${task.id}:`, err);
        });
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
    
    // Clear dependencies and execute
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
  private processRateLimitedTasks(): void {
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
        });
        continue;
      }

      // Check if ready for retry
      if (shouldRetryNow(task)) {
        console.error(`[task-manager] Auto-retrying task ${task.id} (attempt ${(task.retryInfo?.retryCount ?? 0) + 1})`);
        
        if (this.retryCallback) {
          // Mark original task as failed (retried) - new task will be created
          this.updateTask(task.id, {
            status: TaskStatus.FAILED,
            error: `Auto-retried as new task (attempt ${(task.retryInfo?.retryCount ?? 0) + 1}/${task.retryInfo?.maxRetries ?? 6})`,
          });
          this.retryCallback(task);
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

    // Schedule retry processing after the base delay
    setTimeout(() => this.processRateLimitedTasks(), baseDelayMs);
  }

  /**
   * Clear all tasks from memory (used by clear_tasks tool)
   */
  clearAllTasks(): number {
    const count = this.tasks.size;
    this.tasks.clear();
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
    
    // Mark original task as failed (manually retried)
    this.updateTask(task.id, {
      status: TaskStatus.FAILED,
      error: `Manually retried (attempt ${(task.retryInfo?.retryCount ?? 0) + 1}/${task.retryInfo?.maxRetries ?? 6})`,
    });
    
    // Trigger the retry callback - it will spawn a new task and return its ID
    const newTaskId = await this.retryCallback(task);
    
    return { 
      success: true, 
      newTaskId: newTaskId || 'unknown',
    };
  }

  /**
   * Persist tasks to disk (debounced)
   */
  private schedulePersist(trigger: 'state' | 'output' = 'state'): void {
    if (!this.currentCwd) {
      return;
    }

    // Clear existing timeout
    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
    }

    // Use longer debounce for output-only changes (high frequency)
    const debounceMs = trigger === 'output' && this.lastPersistTrigger === 'output'
      ? this.outputPersistDebounceMs
      : this.persistDebounceMs;
    
    this.lastPersistTrigger = trigger;

    this.persistTimeout = setTimeout(() => {
      this.persistNow();
    }, debounceMs);
  }

  /**
   * Persist tasks immediately
   */
  private persistNow(): void {
    if (!this.currentCwd) {
      return;
    }
    const tasks = Array.from(this.tasks.values());
    saveTasks(this.currentCwd, tasks);
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Start periodic health check for running processes
   * Detects zombie processes that exited without proper status update
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkProcessHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Check all RUNNING tasks to verify their processes are still alive
   */
  private checkProcessHealth(): void {
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.RUNNING && task.pid) {
        if (!isProcessAlive(task.pid)) {
          console.error(`[task-manager] Health check: detected dead process for task ${task.id} (pid=${task.pid})`);
          this.updateTask(task.id, {
            status: TaskStatus.FAILED,
            endTime: new Date().toISOString(),
            error: 'Process exited unexpectedly (detected via health check)',
            process: undefined,
            timeoutReason: 'process_dead',
            timeoutContext: {
              pidAlive: false,
              lastHeartbeatAt: task.lastHeartbeatAt,
              lastOutputAt: task.lastOutputAt,
              detectedBy: 'health_check',
            },
          });
        } else {
          const now = Date.now();
          const lastHeartbeat = task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).getTime() : 0;
          if (now - lastHeartbeat >= HEALTH_CHECK_INTERVAL_MS) {
            this.updateTask(task.id, { lastHeartbeatAt: new Date(now).toISOString() });
          }
          if (task.lastOutputAt) {
            const lastOutputAgeMs = now - new Date(task.lastOutputAt).getTime();
            if (lastOutputAgeMs >= TASK_STALL_WARN_MS && task.timeoutReason !== 'stall') {
              this.updateTask(task.id, {
                timeoutReason: 'stall',
                timeoutContext: {
                  lastOutputAt: task.lastOutputAt,
                  lastOutputAgeMs,
                  lastHeartbeatAt: task.lastHeartbeatAt,
                  detectedBy: 'health_check',
                },
              });
            }
          }
        }
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, task] of this.tasks) {
      if (task.status === TaskStatus.COMPLETED || 
          task.status === TaskStatus.FAILED || 
          task.status === TaskStatus.CANCELLED) {
        const endTime = task.endTime ? new Date(task.endTime).getTime() : 0;
        if (now - endTime > TASK_TTL_MS) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      this.tasks.delete(id);
    }

    if (this.tasks.size > MAX_TASKS) {
      const sorted = Array.from(this.tasks.entries())
        .filter(([_, t]) => t.status !== TaskStatus.RUNNING && t.status !== TaskStatus.PENDING)
        .sort((a, b) => new Date(a[1].startTime).getTime() - new Date(b[1].startTime).getTime());

      const toRemove = sorted.slice(0, this.tasks.size - MAX_TASKS);
      for (const [id] of toRemove) {
        this.tasks.delete(id);
      }
    }
  }

  createTask(prompt: string, cwd?: string, model?: string, options?: { autonomous?: boolean; isResume?: boolean; retryInfo?: import('../types.js').RetryInfo; dependsOn?: string[]; labels?: string[]; provider?: import('../types.js').Provider; fallbackAttempted?: boolean; switchAttempted?: boolean }): TaskState {
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
    };
    this.tasks.set(normalizedId, task);
    this.schedulePersist('state');
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
    const updated = { ...task, ...updates };
    this.tasks.set(normalizedId, updated);
    this.schedulePersist('state');
    
    // When a task completes, check if any waiting tasks can now run
    if (updates.status === TaskStatus.COMPLETED && previousStatus !== TaskStatus.COMPLETED) {
      this.processWaitingTasks();
    }
    
    return updated;
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

  cancelTask(id: string): { success: boolean; alreadyDead?: boolean; error?: string } {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING && task.status !== TaskStatus.WAITING) {
      return { success: false, error: `Task is not cancellable (status: ${task.status})` };
    }

    let alreadyDead = false;
    if (task.process) {
      // First check if process is actually alive
      if (task.pid && !isProcessAlive(task.pid)) {
        alreadyDead = true;
        console.error(`[task-manager] Cancel: process for task ${task.id} was already dead (pid=${task.pid})`);
      } else {
        try {
          task.process.kill('SIGTERM');
        } catch (err) {
          // Process may already be dead
          alreadyDead = true;
          console.error(`[task-manager] Cancel: kill failed for task ${task.id}: ${err}`);
        }
      }
    }

    task.status = TaskStatus.CANCELLED;
    task.endTime = new Date().toISOString();
    if (alreadyDead) {
      task.error = 'Process had already exited before cancellation';
    }
    task.process = undefined;
    this.schedulePersist('state');
    return { success: true, alreadyDead };
  }

  shutdown(): void {
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

    for (const task of this.tasks.values()) {
      if (task.process && task.status === TaskStatus.RUNNING) {
        try {
          task.process.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
    }

    // Final persist before shutdown
    this.persistNow();
  }
}

export const taskManager = new TaskManager();
