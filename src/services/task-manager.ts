import { nanoid } from 'nanoid';
import { TaskState, TaskStatus } from '../types.js';

const MAX_TASKS = 100;
const TASK_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LINES = 2000;

class TaskManager {
  private tasks: Map<string, TaskState> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
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

  createTask(prompt: string, cwd?: string, model?: string, options?: { silent?: boolean; autonomous?: boolean; isResume?: boolean }): TaskState {
    const id = nanoid(12);
    const task: TaskState = {
      id,
      status: TaskStatus.PENDING,
      prompt,
      output: [],
      startTime: new Date().toISOString(),
      cwd,
      model,
      silent: options?.silent,
      autonomous: options?.autonomous,
      isResume: options?.isResume,
    };
    this.tasks.set(id, task);
    return task;
  }

  getTask(id: string): TaskState | null {
    return this.tasks.get(id) || null;
  }

  updateTask(id: string, updates: Partial<TaskState>): TaskState | null {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }

    const updated = { ...task, ...updates };
    this.tasks.set(id, updated);
    return updated;
  }

  appendOutput(id: string, line: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.output.push(line);
      
      if (task.output.length > MAX_OUTPUT_LINES) {
        task.output = task.output.slice(-MAX_OUTPUT_LINES);
      }
      
      if (!task.sessionId) {
        const sessionMatch = line.match(/(?:Session ID:|session[_-]?id[=:]?)\s*([a-zA-Z0-9_-]+)/i);
        if (sessionMatch) {
          task.sessionId = sessionMatch[1];
        }
      }
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
    const task = this.tasks.get(id);
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
    return true;
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
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
  }
}

export const taskManager = new TaskManager();
