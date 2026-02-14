import { open, mkdir } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { join } from 'path';

const OUTPUT_DIR_NAME = '.super-agents';

// Cache of directories known to exist — avoids stat syscall on every append
const knownDirs = new Set<string>();

// Persistent file handles — one per task, closed on finalize
const openHandles = new Map<string, FileHandle>();

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
  return join(getOutputDir(cwd), `${taskId}.output`);
}

/**
 * Ensure output directory exists (async, cached)
 */
async function ensureOutputDir(cwd: string): Promise<boolean> {
  const dir = getOutputDir(cwd);
  if (knownDirs.has(dir)) return true;
  try {
    await mkdir(dir, { recursive: true });
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
    // Write header and close immediately — appendToOutputFile will open
    // its own persistent handle on first call. This avoids a race where
    // both createOutputFile and appendToOutputFile store handles, orphaning one.
    const handle = await open(outputPath, 'w');
    await handle.write(header);
    await handle.close();
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
  try {
    let handle = openHandles.get(key);
    if (!handle) {
      // Re-open in append mode if handle was lost (e.g. after restart)
      await ensureOutputDir(cwd);
      handle = await open(getOutputPath(cwd, taskId), 'a');
      openHandles.set(key, handle);
    }
    await handle.write(line + '\n');
    return true;
  } catch {
    // Silent failure — don't break task execution for file I/O issues
    // Remove broken handle so next call re-opens
    openHandles.delete(key);
    return false;
  }
}

/**
 * Append completion footer to output file and close handle
 */
export async function finalizeOutputFile(cwd: string, taskId: string, status: string, error?: string): Promise<boolean> {
  const key = `${cwd}:${taskId}`;
  try {
    const footer = [
      '',
      '─'.repeat(60),
      `# Completed: ${new Date().toISOString()}`,
      `# Status: ${status}`,
      error ? `# Error: ${error}` : null,
    ].filter(Boolean).join('\n') + '\n';

    let handle = openHandles.get(key);
    if (!handle) {
      handle = await open(getOutputPath(cwd, taskId), 'a');
    }
    await handle.write(footer);
    await handle.close();
    openHandles.delete(key);
    return true;
  } catch {
    openHandles.delete(key);
    return false;
  }
}

/**
 * Close all open file handles (called during shutdown)
 */
export async function closeAllOutputHandles(): Promise<void> {
  for (const [key, handle] of openHandles) {
    try {
      await handle.close();
    } catch {
      // Ignore close errors during shutdown
    }
    openHandles.delete(key);
  }
}
