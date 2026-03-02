import { createHash } from 'crypto';
import { mkdir, readFile, rename, unlink, access, constants, open as openFile, lstat, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { TaskState, TaskStatus } from '../types.js';

const STORAGE_DIR_NAME = '.super-agents';

// Cache to avoid repeated mkdir calls
let storageDirExists = false;

// Write mutex to serialize concurrent saveTasks calls
let writeChain = Promise.resolve();

// Dirty tracking: skip writes when serialized data hasn't changed
let lastSerializedHash = '';

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
 * Ensure storage directory exists (async, cached)
 */
async function ensureStorageDir(): Promise<boolean> {
  if (storageDirExists) return true;
  try {
    await mkdir(getStorageDir(), { recursive: true, mode: 0o700 });

    // Verify storage directory is not a symlink
    try {
      const stats = await lstat(getStorageDir());
      if (stats.isSymbolicLink()) {
        console.error('[task-persistence] Storage directory is a symlink, refusing to use');
        return false;
      }
    } catch { /* dir doesn't exist yet, fine */ }

    storageDirExists = true;
    return true;
  } catch (error) {
    console.error(`[task-persistence] Failed to create storage directory: ${error}`);
    return false;
  }
}

/**
 * Serialize tasks for persistence (excludes non-serializable fields)
 */
interface PersistedData {
  version: 2;
  tasks: Array<Omit<TaskState, 'session'>>;
  cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>;
}

function serializeTasks(tasks: TaskState[], cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>): string {
  const serializable = tasks.map(task => {
    // Exclude session reference as it's non-serializable
    const { session, ...rest } = task;
    return rest;
  });
  const data: PersistedData = {
    version: 2,
    tasks: serializable,
    cooldowns,
  };
  return JSON.stringify(data);
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
  // Pass 1: Recover RUNNING/PENDING → FAILED, keep RATE_LIMITED
  const pass1 = tasks.map(task => {
    if (task.status === TaskStatus.RATE_LIMITED) {
      return applyTaskDefaults(task);
    }
    if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PENDING || task.status === TaskStatus.WAITING) {
      const prevStatus = task.status;
      return applyTaskDefaults({
        ...task,
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: prevStatus === TaskStatus.WAITING
          ? 'Server restarted while task was waiting for dependencies'
          : 'Server restarted - task was interrupted',
        timeoutReason: 'server_restart',
        timeoutContext: { detectedBy: 'startup_recovery' },
      });
    }
    return applyTaskDefaults(task);
  });

  // Pass 2: Fail WAITING tasks whose dependencies are now all terminal/missing
  // (they can never be satisfied since no process will complete their deps)
  const taskMap = new Map(pass1.map(t => [t.id, t]));
  return pass1.map(task => {
    if (task.status !== TaskStatus.WAITING || !task.dependsOn?.length) return task;

    const hasViableDep = task.dependsOn.some(depId => {
      const dep = taskMap.get(depId);
      // A dep is viable if it exists and is in a non-terminal, non-waiting state
      // After pass1, only RATE_LIMITED and COMPLETED survive as non-terminal
      return dep && (dep.status === TaskStatus.COMPLETED || dep.status === TaskStatus.RATE_LIMITED);
    });

    if (!hasViableDep) {
      return {
        ...task,
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: 'Server restarted - dependencies cannot be satisfied',
        timeoutReason: 'server_restart' as const,
        timeoutContext: { detectedBy: 'startup_recovery' as const },
      };
    }
    return task;
  });
}

/**
 * Save tasks to disk with atomic write (async)
 */
export async function saveTasks(cwd: string, tasks: TaskState[], cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    writeChain = writeChain.then(async () => {
      if (!(await ensureStorageDir())) {
        resolve(false);
        return;
      }

      const filePath = getStoragePath(cwd);
      const tempPath = `${filePath}.tmp.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

      try {
        const data = serializeTasks(tasks, cooldowns);

        // Skip write if data hasn't changed (dirty check via length + hash)
        const quickHash = `${data.length}:${data.charCodeAt(0)}:${data.charCodeAt(data.length - 1)}:${data.charCodeAt(data.length >> 1)}`;
        if (quickHash === lastSerializedHash) {
          resolve(true);
          return;
        }

        // Atomic write: open with restrictive perms, fsync, then rename
        const fd = await openFile(tempPath, 'w', 0o600);
        await fd.write(data);
        await fd.datasync();
        await fd.close();
        await rename(tempPath, filePath);
        lastSerializedHash = quickHash;

        resolve(true);
      } catch (error) {
        console.error(`[task-persistence] Failed to save tasks: ${error}`);
        storageDirExists = false; // Force re-check next time

        // Clean up temp file if it exists
        try {
          await unlink(tempPath);
        } catch {
          // Ignore cleanup errors
        }

        resolve(false);
      }
    }).catch(() => resolve(false));
  });
}

/**
 * Load tasks from disk (async)
 * Returns empty array if file doesn't exist or is corrupted
 * Marks orphaned running tasks as failed
 */
export async function loadTasks(cwd: string): Promise<{ tasks: TaskState[]; cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }> }> {
  const filePath = getStoragePath(cwd);

  // Clean up any orphaned .tmp files from previous crashes
  try {
    const { readdir } = await import('fs/promises');
    const dir = getStorageDir();
    const base = `${hashCwd(cwd)}.json.tmp.`;
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith(base)) {
        try { await unlink(join(dir, entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  try {
    await access(filePath, constants.R_OK);
  } catch {
    return { tasks: [], cooldowns: undefined };
  }

  try {
    // Guard against loading excessively large files
    const fileStats = await stat(filePath);
    const MAX_PERSIST_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (fileStats.size > MAX_PERSIST_FILE_SIZE) {
      console.error(`[task-persistence] Persistence file too large (${fileStats.size} bytes), starting fresh`);
      return { tasks: [], cooldowns: undefined };
    }

    const data = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    // Support both v1 (plain array) and v2 (object with tasks + cooldowns) formats
    let tasks: TaskState[];
    let cooldowns: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }> | undefined;

    if (Array.isArray(parsed)) {
      // v1 format: plain array of tasks
      tasks = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
      // v2 format: { version, tasks, cooldowns }
      tasks = parsed.tasks;
      cooldowns = parsed.cooldowns;
    } else {
      console.error('[task-persistence] Invalid tasks file format, starting fresh');
      return { tasks: [], cooldowns: undefined };
    }

    // Validate each task has minimum required fields
    const validTasks = tasks.filter((t: any) =>
      t && typeof t === 'object' &&
      typeof t.id === 'string' && t.id.length > 0 &&
      typeof t.status === 'string' &&
      typeof t.prompt === 'string'
    );
    if (validTasks.length !== tasks.length) {
      console.error(`[task-persistence] Filtered out ${tasks.length - validTasks.length} invalid task(s)`);
    }

    // Recover orphaned tasks (server crashed while they were running)
    return { tasks: recoverOrphanedTasks(validTasks as TaskState[]), cooldowns };
  } catch (error) {
    console.error(`[task-persistence] Failed to load tasks (corrupted?), starting fresh: ${error}`);
    return { tasks: [], cooldowns: undefined };
  }
}

/**
 * Delete storage file for a cwd (for testing/cleanup)
 */
export async function deleteStorage(cwd: string): Promise<boolean> {
  const filePath = getStoragePath(cwd);

  try {
    await unlink(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return true; // Already gone
    console.error(`[task-persistence] Failed to delete storage: ${error}`);
    return false;
  }
}
