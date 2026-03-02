import { open, mkdir, lstat } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { join } from 'path';

const OUTPUT_DIR_NAME = '.super-agents';

const MAX_KNOWN_DIRS = 500;

// Cache of directories known to exist — avoids stat syscall on every append
const knownDirs = new Set<string>();

// Persistent file handles — one per task, closed on finalize
const openHandles = new Map<string, FileHandle>();

// Track tasks that have already logged a write failure (suppress repeats)
const warnedTasks = new Set<string>();

// Track finalized tasks to prevent appends after finalization
const finalizedKeys = new Set<string>();

// Track when each handle was opened for stale handle cleanup
const handleOpenTimes = new Map<string, number>();

// Track last successful write time per handle for stale detection (PR-006)
const handleLastWriteTime = new Map<string, number>();

// Prevent concurrent opens from racing on the same key
const pendingOpens = new Map<string, Promise<FileHandle>>();

// Serialize writes/finalization per task key to avoid interleaving races
const writeQueues = new Map<string, Promise<void>>();

/**
 * Strip path separators and null bytes to prevent path traversal
 */
function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[\/\\:\x00]/g, '_');
}

/**
 * Get or open a file handle, deduplicating concurrent opens for the same key
 */
async function getOrOpenHandle(key: string, filePath: string): Promise<FileHandle> {
  let handle = openHandles.get(key);
  if (handle) return handle;

  let pending = pendingOpens.get(key);
  if (pending) return pending;

  pending = open(filePath, 'a', 0o600).then(h => {
    openHandles.set(key, h);
    handleOpenTimes.set(key, Date.now());
    pendingOpens.delete(key);
    return h;
  }).catch(err => {
    pendingOpens.delete(key);
    throw err;
  });
  pendingOpens.set(key, pending);
  return pending;
}

function enqueueWrite<T>(key: string, writeOp: () => Promise<T>): Promise<T> {
  const tail = writeQueues.get(key) ?? Promise.resolve();
  const run = tail.then(writeOp, writeOp);
  const nextTail = run.then(() => undefined, () => undefined);
  writeQueues.set(key, nextTail);
  return run.finally(() => {
    if (writeQueues.get(key) === nextTail) {
      writeQueues.delete(key);
    }
  });
}

/**
 * Get the output directory path for a given cwd
 * Returns: {cwd}/.super-agents/
 */
export function getOutputDir(cwd: string): string {
  return join(cwd, OUTPUT_DIR_NAME);
}

/**
 * Get the output file path for a task
 * Returns: {cwd}/.super-agents/{taskId}.output
 */
export function getOutputPath(cwd: string, taskId: string): string {
  return join(getOutputDir(cwd), `${sanitizeTaskId(taskId)}.output`);
}

/**
 * Ensure output directory exists (async, cached)
 */
async function ensureOutputDir(cwd: string): Promise<boolean> {
  const dir = getOutputDir(cwd);
  if (knownDirs.has(dir)) return true;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stats = await lstat(dir);
    if (stats.isSymbolicLink()) {
      console.error('[output-file] Output directory is a symlink, refusing to use');
      return false;
    }
    if (knownDirs.size > MAX_KNOWN_DIRS) {
      knownDirs.clear();
    }
    knownDirs.add(dir);
    return true;
  } catch (error) {
    console.error(`[output-file] Failed to create output directory: ${error}`);
    return false;
  }
}

/**
 * Create an empty output file for a task
 * Returns the absolute path to the output file, or null on failure
 */
export async function createOutputFile(cwd: string, taskId: string): Promise<string | null> {
  if (!(await ensureOutputDir(cwd))) {
    return null;
  }

  const outputPath = getOutputPath(cwd, taskId);

  try {
    const header = `# Task: ${taskId}\n# Started: ${new Date().toISOString()}\n# Working directory: ${cwd}\n${'─'.repeat(60)}\n\n`;
    // Use a+ and only write header when file is empty to avoid truncating
    // lines that may have been appended concurrently by appendToOutputFile.
    // PR-009: If the file already has content (race with append), the size > 0
    // check intentionally skips the header — this is safe and by design.
    const handle = await open(outputPath, 'a+', 0o600);
    try {
      const fileStat = await handle.stat();
      if (fileStat.size === 0) {
        await handle.write(header);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return outputPath;
  } catch (error) {
    console.error(`[output-file] Failed to create output file: ${error}`);
    return null;
  }
}

/**
 * Append a line to the task's output file (async, uses persistent handle)
 */
export async function appendToOutputFile(cwd: string, taskId: string, line: string): Promise<boolean> {
  const key = `${cwd}:${taskId}`;

  // Block appends to finalized tasks
  if (finalizedKeys.has(key)) return false;

  try {
    if (!(await ensureOutputDir(cwd))) {
      return false;
    }
    return await enqueueWrite(key, async () => {
      // Re-check inside queue (finalize may have raced after initial check)
      if (finalizedKeys.has(key)) {
        return false;
      }
      const handle = await getOrOpenHandle(key, getOutputPath(cwd, taskId));

      // Re-check finalized after async open (finalize may have raced)
      if (finalizedKeys.has(key)) {
        return false;
      }

      await handle.write(line + '\n');
      handleLastWriteTime.set(key, Date.now());
      return true;
    });
  } catch {
    // Don't break task execution for file I/O issues
    // RM-004: Close broken handle before discarding reference
    const brokenHandle = openHandles.get(key);
    openHandles.delete(key);
    handleOpenTimes.delete(key);
    handleLastWriteTime.delete(key);
    pendingOpens.delete(key);
    if (brokenHandle) {
      brokenHandle.close().catch(() => {});
    }
    if (!warnedTasks.has(key)) {
      warnedTasks.add(key);
      console.error(`[output-file] Write failed for ${key} (further errors suppressed)`);
    }
    return false;
  }
}

/**
 * Append completion footer to output file and close handle
 */
export async function finalizeOutputFile(cwd: string, taskId: string, status: string, error?: string): Promise<boolean> {
  const key = `${cwd}:${taskId}`;
  finalizedKeys.add(key); // Block further appends immediately
  try {
    const footer = [
      '',
      '─'.repeat(60),
      `# Completed: ${new Date().toISOString()}`,
      `# Status: ${status}`,
      error ? `# Error: ${error}` : null,
    ].filter(Boolean).join('\n') + '\n';

    return await enqueueWrite(key, async () => {
      const handle = await getOrOpenHandle(key, getOutputPath(cwd, taskId));
      await handle.write(footer);
      await handle.close();
      openHandles.delete(key);
      handleOpenTimes.delete(key);
      handleLastWriteTime.delete(key);
      pendingOpens.delete(key);
      return true;
    });
  } catch {
    openHandles.delete(key);
    handleOpenTimes.delete(key);
    handleLastWriteTime.delete(key);
    pendingOpens.delete(key);
    writeQueues.delete(key);
    return false;
  }
}

/**
 * Close file handles that have been open longer than maxAgeMs
 */
export async function closeStaleHandles(maxAgeMs: number): Promise<void> {
  const now = Date.now();
  for (const [key, openedAt] of handleOpenTimes) {
    // PR-006: Prefer last-write time for staleness; fall back to open time
    const lastActive = handleLastWriteTime.get(key) ?? openedAt;
    if (now - lastActive > maxAgeMs) {
      const handle = openHandles.get(key);
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Ignore close errors on stale handles
        }
      }
      openHandles.delete(key);
      handleOpenTimes.delete(key);
      handleLastWriteTime.delete(key);
    }
  }
  // RM-008: Bound warnedTasks set to prevent unbounded growth
  if (warnedTasks.size > 500) warnedTasks.clear();

  // Cap finalizedKeys growth: only evict entries whose handles AND queues are fully closed
  // Keep entries that still have open handles to prevent post-finalization writes
  if (finalizedKeys.size > 1000) {
    let toRemove = finalizedKeys.size - 900;
    const keysToCheck = [...finalizedKeys];
    for (const fk of keysToCheck) {
      if (toRemove <= 0) break;
      // Only safe to evict if handle is closed AND no pending writes AND output dir cleaned
      if (!openHandles.has(fk) && !writeQueues.has(fk) && !handleLastWriteTime.has(fk)) {
        finalizedKeys.delete(fk);
        toRemove--;
      }
    }
  }
}

/**
 * Close all open file handles (called during shutdown)
 */
export async function closeAllOutputHandles(): Promise<void> {
  // Drain all pending write queues before closing handles
  const pendingWrites = Array.from(writeQueues.values());
  if (pendingWrites.length > 0) {
    await Promise.allSettled(pendingWrites);
  }

  for (const [key, handle] of openHandles) {
    try {
      await handle.close();
    } catch {
      // Ignore close errors during shutdown
    }
    openHandles.delete(key);
  }
  handleOpenTimes.clear();
  handleLastWriteTime.clear();
  warnedTasks.clear();
  pendingOpens.clear();
  writeQueues.clear();
}

// Periodic stale handle cleanup — runs every 60s, closes handles open > 5min
const STALE_HANDLE_CHECK_INTERVAL = 60_000;
const STALE_HANDLE_MAX_AGE = 5 * 60_000;
let staleHandleTimer: NodeJS.Timeout | undefined;
staleHandleTimer = setInterval(() => {
  closeStaleHandles(STALE_HANDLE_MAX_AGE).catch(() => {});
}, STALE_HANDLE_CHECK_INTERVAL);
staleHandleTimer.unref(); // Don't prevent Node.js from exiting

export async function shutdownOutputFileCleanup(): Promise<void> {
  if (staleHandleTimer) clearInterval(staleHandleTimer);
  await closeAllOutputHandles();
}
