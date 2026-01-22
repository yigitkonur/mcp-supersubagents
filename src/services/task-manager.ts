import { generateTaskId, normalizeTaskId } from '../utils/task-id-generator.js';
import { TaskState, TaskStatus } from '../types.js';
import { saveTasks, loadTasks } from './task-persistence.js';
import { shouldRetryNow, hasExceededMaxRetries } from './retry-queue.js';

const MAX_TASKS = 100;
const TASK_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LINES = 2000;

class TaskManager {
  private tasks: Map<string, TaskState> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private currentCwd: string | null = null;
  private persistTimeout: NodeJS.Timeout | null = null;
  private persistDebounceMs = 100;
  private outputPersistDebounceMs = 1000;
  private lastPersistTrigger: 'state' | 'output' = 'state';
  private retryCallback: ((task: TaskState) => Promise<string | undefined>) | null = null;

  constructor() {
    this.startCleanup();
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

  createTask(prompt: string, cwd?: string, model?: string, options?: { autonomous?: boolean; isResume?: boolean; retryInfo?: import('../types.js').RetryInfo }): TaskState {
    const id = generateTaskId();
    const normalizedId = normalizeTaskId(id);
    const task: TaskState = {
      id,
      status: TaskStatus.PENDING,
      prompt,
      output: [],
      startTime: new Date().toISOString(),
      cwd,
      model,
      autonomous: options?.autonomous,
      isResume: options?.isResume,
      retryInfo: options?.retryInfo,
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

    const updated = { ...task, ...updates };
    this.tasks.set(normalizedId, updated);
    this.schedulePersist('state');
    return updated;
  }

  appendOutput(id: string, line: string): void {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (task) {
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

  cancelTask(id: string): boolean {
    const normalizedId = normalizeTaskId(id);
    const task = this.tasks.get(normalizedId);
    if (!task) {
      return false;
    }

    if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING) {
      return false;
    }

    if (task.process) {
      try {
        task.process.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }

    task.status = TaskStatus.CANCELLED;
    task.endTime = new Date().toISOString();
    this.schedulePersist('state');
    return true;
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
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
