import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

const OUTPUT_DIR_NAME = '.super-agents';

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
 * Ensure output directory exists
 */
function ensureOutputDir(cwd: string): boolean {
  try {
    const dir = getOutputDir(cwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
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
export function createOutputFile(cwd: string, taskId: string): string | null {
  if (!ensureOutputDir(cwd)) {
    return null;
  }

  const outputPath = getOutputPath(cwd, taskId);
  
  try {
    // Create with header
    const header = `# Task: ${taskId}\n# Started: ${new Date().toISOString()}\n# Working directory: ${cwd}\n${'─'.repeat(60)}\n\n`;
    writeFileSync(outputPath, header, 'utf-8');
    return outputPath;
  } catch (error) {
    console.error(`[output-file] Failed to create output file: ${error}`);
    return null;
  }
}

/**
 * Append a line to the task's output file
 */
export function appendToOutputFile(cwd: string, taskId: string, line: string): boolean {
  const outputPath = getOutputPath(cwd, taskId);
  
  try {
    // Ensure directory exists (in case it was deleted)
    ensureOutputDir(cwd);
    appendFileSync(outputPath, line + '\n', 'utf-8');
    return true;
  } catch (error) {
    // Silent failure - don't break task execution for file I/O issues
    return false;
  }
}

/**
 * Append completion footer to output file
 */
export function finalizeOutputFile(cwd: string, taskId: string, status: string, error?: string): boolean {
  const outputPath = getOutputPath(cwd, taskId);
  
  try {
    const footer = [
      '',
      '─'.repeat(60),
      `# Completed: ${new Date().toISOString()}`,
      `# Status: ${status}`,
      error ? `# Error: ${error}` : null,
    ].filter(Boolean).join('\n') + '\n';
    
    appendFileSync(outputPath, footer, 'utf-8');
    return true;
  } catch (error) {
    return false;
  }
}
