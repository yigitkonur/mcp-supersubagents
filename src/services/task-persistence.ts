import { createHash } from 'crypto';
import { mkdir, readFile, rename, unlink, access, constants, open as openFile, lstat, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { TaskState, TaskStatus } from '../types.js';
import { isErrnoException } from '../utils/is-errno-exception.js';

const STORAGE_DIR_NAME = '.super-agents';

// Cache to avoid repeated mkdir calls
let storageDirExists = false;

// Write mutex to serialize concurrent saveTasks calls (per cwd/filePath)
const writeChains = new Map<string, Promise<void>>();

// Dirty tracking: skip writes when serialized data hasn't changed (per cwd/filePath)
const lastSerializedHashes = new Map<string, string>();

// PR-011: Write coalescing — collapse rapid writes to at most 2 per filePath
const writeInProgressSet = new Set<string>();
const writePendingArgs = new Map<string, { cwd: string; tasks: TaskState[]; cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }> }>();

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
  tasks: Array<Omit<TaskState, 'providerState'>>;
  cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>;
}

function serializeTasks(tasks: TaskState[], cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>): string {
  // PR-010: Safe per-task serialization — exclude tasks that fail to serialize
  const safeTasks = tasks.filter(task => {
    try {
      const { providerState, ...rest } = task;
      JSON.stringify(rest);
      return true;
    } catch {
      console.error(`[task-persistence] Task ${task.id} not serializable — excluded`);
      return false;
    }
  });

  const serializable = safeTasks.map(task => {
    // Exclude providerState as it's non-serializable (opaque per-provider data)
    const { providerState, ...rest } = task;
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
  // All non-terminal tasks (RUNNING, PENDING, WAITING) → FAILED on restart
  // RATE_LIMITED tasks are preserved for retry
  return tasks.map(task => {
    if (task.status === TaskStatus.RATE_LIMITED) {
      return applyTaskDefaults(task);
    }
    if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PENDING || task.status === TaskStatus.WAITING) {
      // PR-012: For WAITING tasks, check if deps are all satisfied → promote to PENDING
      if (task.status === TaskStatus.WAITING && task.dependsOn) {
        const allDepsSatisfied = task.dependsOn.every((depId: string) => {
          const dep = tasks.find(t => t.id === depId);
          return dep && dep.status === TaskStatus.COMPLETED;
        });
        if (allDepsSatisfied) {
          return applyTaskDefaults({
            ...task,
            status: TaskStatus.PENDING,
          });
        }
      }

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
}

/**
 * Save tasks to disk with atomic write (async)
 */
export async function saveTasks(cwd: string, tasks: TaskState[], cooldowns?: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>): Promise<boolean> {
  const filePath = getStoragePath(cwd);

  // PR-011: Write coalescing — if a write is in progress, queue latest data.
  // Returns true to indicate the data is accepted (will be written when current write completes).
  // Note: data is NOT yet on disk at this point. Callers should not assume durability.
  if (writeInProgressSet.has(filePath)) {
    writePendingArgs.set(filePath, { cwd, tasks, cooldowns });
    return true;
  }

  writeInProgressSet.add(filePath);

  try {
    return await new Promise<boolean>((resolve) => {
      const chain = writeChains.get(filePath) ?? Promise.resolve();
      writeChains.set(filePath, chain.then(async () => {
        if (!(await ensureStorageDir())) {
          resolve(false);
          return;
        }

        const tempPath = `${filePath}.tmp.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

        try {
          const data = serializeTasks(tasks, cooldowns);

          // Skip write if data hasn't changed (dirty check via length + hash)
          const quickHash = createHash('md5').update(data).digest('hex');
          if (quickHash === lastSerializedHashes.get(filePath)) {
            resolve(true);
            return;
          }

          // Atomic write: open with restrictive perms, fsync, then rename
          const fd = await openFile(tempPath, 'w', 0o600);
          await fd.writeFile(data, 'utf-8');
          await fd.datasync();
          await fd.close();
          await rename(tempPath, filePath);
          lastSerializedHashes.set(filePath, quickHash);

          // PR-013: Evict stale hash entries to prevent unbounded growth
          if (lastSerializedHashes.size > 50) {
            for (const key of lastSerializedHashes.keys()) {
              if (!writeChains.has(key)) lastSerializedHashes.delete(key);
            }
          }

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
      }).catch(() => resolve(false)));
    });
  } finally {
    writeInProgressSet.delete(filePath);
    // PR-011: If a write was queued while we were writing, run it now
    const pending = writePendingArgs.get(filePath);
    if (pending) {
      writePendingArgs.delete(filePath);
      saveTasks(pending.cwd, pending.tasks, pending.cooldowns).catch((err) => {
        console.error(`[task-persistence] Coalesced write failed:`, err instanceof Error ? err.message : err);
      });
    }
  }
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
      const backupPath = `${filePath}.corrupt.${Date.now()}`;
      try {
        await rename(filePath, backupPath);
        console.error(`[task-persistence] Oversized file backed up to ${backupPath}`);
      } catch { /* best effort */ }
      return { tasks: [], cooldowns: undefined };
    }

    const data = await readFile(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (parseErr: unknown) {
      console.error(`[task-persistence] JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      const backupPath = `${filePath}.corrupt.${Date.now()}`;
      try {
        await rename(filePath, backupPath);
        console.error(`[task-persistence] Corrupted file backed up to ${backupPath}`);
      } catch { /* best effort */ }
      return { tasks: [], cooldowns: undefined };
    }

    // PR-008: Version guard for future formats
    const parsedRecord = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : null;

    if (parsedRecord !== null && typeof parsedRecord['version'] === 'number' && parsedRecord['version'] > 2) {
      console.error(`[task-persistence] Persistence file version ${parsedRecord['version']} is newer than supported (2). Data may be corrupted — please upgrade or delete ${filePath}`);
      return { tasks: [], cooldowns: undefined };
    }

    // Support both v1 (plain array) and v2 (object with tasks + cooldowns) formats
    let rawTasks: unknown[];
    let cooldowns: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }> | undefined;

    if (Array.isArray(parsed)) {
      // v1 format: plain array of tasks
      rawTasks = parsed;
    } else if (parsedRecord !== null && Array.isArray(parsedRecord['tasks'])) {
      // v2 format: { version, tasks, cooldowns }
      rawTasks = parsedRecord['tasks'];
      cooldowns = parsedRecord['cooldowns'] as typeof cooldowns;
    } else {
      console.error('[task-persistence] Invalid tasks file format, starting fresh');
      return { tasks: [], cooldowns: undefined };
    }

    // Validate each task has minimum required fields
    const validTasks = rawTasks.filter((t): t is TaskState =>
      t !== null && typeof t === 'object' &&
      typeof (t as Record<string, unknown>)['id'] === 'string' && ((t as Record<string, unknown>)['id'] as string).length > 0 &&
      typeof (t as Record<string, unknown>)['status'] === 'string' &&
      typeof (t as Record<string, unknown>)['prompt'] === 'string'
    );
    if (validTasks.length !== rawTasks.length) {
      console.error(`[task-persistence] Filtered out ${rawTasks.length - validTasks.length} invalid task(s)`);
    }

    // Recover orphaned tasks (server crashed while they were running)
    return { tasks: recoverOrphanedTasks(validTasks), cooldowns };
  } catch (error) {
    console.error(`[task-persistence] Failed to load tasks: ${error}`);
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await rename(filePath, backupPath);
      console.error(`[task-persistence] Corrupted file backed up to ${backupPath}`);
    } catch { /* best effort */ }
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
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') return true; // Already gone
    console.error(`[task-persistence] Failed to delete storage: ${error}`);
    return false;
  }
}
