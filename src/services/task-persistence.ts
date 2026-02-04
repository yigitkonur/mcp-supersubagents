import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { TaskState, TaskStatus } from '../types.js';

const STORAGE_DIR_NAME = '.super-agents';

/**
 * Get the storage directory path (~/.super-agents/)
 */
export function getStorageDir(): string {
  return join(homedir(), STORAGE_DIR_NAME);
}

/**
 * Get MD5 hash of a string
 */
export function hashCwd(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex');
}

/**
 * Get the storage file path for a given cwd
 * Returns: ~/.super-agents/{md5(cwd)}.json
 */
export function getStoragePath(cwd: string): string {
  return join(getStorageDir(), `${hashCwd(cwd)}.json`);
}

/**
 * Ensure storage directory exists
 */
function ensureStorageDir(): boolean {
  try {
    const dir = getStorageDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return true;
  } catch (error) {
    console.error(`[task-persistence] Failed to create storage directory: ${error}`);
    return false;
  }
}

/**
 * Serialize tasks for persistence (excludes non-serializable fields)
 */
function serializeTasks(tasks: TaskState[]): string {
  const serializable = tasks.map(task => {
    // Exclude session reference as it's non-serializable
    const { session, ...rest } = task;
    return rest;
  });
  return JSON.stringify(serializable, null, 2);
}

/**
 * Mark orphaned running/pending tasks as failed (server crashed)
 * Note: RATE_LIMITED tasks are preserved for auto-retry
 */
function applyTaskDefaults(task: TaskState): TaskState {
  const startTime = task.startTime || new Date().toISOString();
  return {
    ...task,
    startTime,
    lastHeartbeatAt: task.lastHeartbeatAt ?? startTime,
  };
}

function recoverOrphanedTasks(tasks: TaskState[]): TaskState[] {
  return tasks.map(task => {
    // Keep rate-limited tasks as-is for auto-retry
    if (task.status === TaskStatus.RATE_LIMITED) {
      return applyTaskDefaults(task);
    }
    
    // Mark running/pending as failed (server crashed)
    if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PENDING) {
      const updated: TaskState = {
        ...task,
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: 'Server restarted - task was interrupted',
        timeoutReason: 'server_restart',
        timeoutContext: {
          detectedBy: 'startup_recovery',
        },
      };
      return applyTaskDefaults(updated);
    }
    return applyTaskDefaults(task);
  });
}

/**
 * Save tasks to disk with atomic write
 */
export function saveTasks(cwd: string, tasks: TaskState[]): boolean {
  if (!ensureStorageDir()) {
    return false;
  }

  const filePath = getStoragePath(cwd);
  const tempPath = `${filePath}.tmp`;

  try {
    const data = serializeTasks(tasks);
    
    // Atomic write: write to temp file, then rename
    writeFileSync(tempPath, data, 'utf-8');
    renameSync(tempPath, filePath);
    
    return true;
  } catch (error) {
    console.error(`[task-persistence] Failed to save tasks: ${error}`);
    
    // Clean up temp file if it exists
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    
    return false;
  }
}

/**
 * Load tasks from disk
 * Returns empty array if file doesn't exist or is corrupted
 * Marks orphaned running tasks as failed
 */
export function loadTasks(cwd: string): TaskState[] {
  const filePath = getStoragePath(cwd);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const data = readFileSync(filePath, 'utf-8');
    const tasks = JSON.parse(data) as TaskState[];
    
    if (!Array.isArray(tasks)) {
      console.error('[task-persistence] Invalid tasks file format, starting fresh');
      return [];
    }

    // Recover orphaned tasks (server crashed while they were running)
    return recoverOrphanedTasks(tasks);
  } catch (error) {
    console.error(`[task-persistence] Failed to load tasks (corrupted?), starting fresh: ${error}`);
    return [];
  }
}

/**
 * Delete storage file for a cwd (for testing/cleanup)
 */
export function deleteStorage(cwd: string): boolean {
  const filePath = getStoragePath(cwd);
  
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return true;
  } catch (error) {
    console.error(`[task-persistence] Failed to delete storage: ${error}`);
    return false;
  }
}
