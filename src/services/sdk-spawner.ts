/**
 * SDK Spawner - Spawns and manages Copilot tasks using the native Copilot SDK.
 * 
 * This replaces the old execa-based process-spawner with native SDK sessions.
 * Key improvements:
 * - Native session management instead of process spawning
 * - Event-based output streaming with proper SDK types
 * - Mid-session rate limit detection and automatic account rotation
 * - Proper session lifecycle management with resume support
 */

import type { SessionConfig, CopilotSession } from '@github/copilot-sdk';
import { existsSync } from 'fs';
import { taskManager } from './task-manager.js';
import { clientContext } from './client-context.js';
import { sdkClientManager } from './sdk-client-manager.js';
import { sdkSessionAdapter } from './sdk-session-adapter.js';
import { TaskStatus, type SpawnOptions, type TaskState, isTerminalStatus, ROTATABLE_STATUS_CODES } from '../types.js';
import { resolveModel } from '../models.js';
import { createRetryInfo } from './retry-queue.js';
import { TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';
import { shouldFallbackToClaudeCode } from './exhaustion-fallback.js';
import { buildHandoffPrompt } from './session-snapshot.js';
import { runClaudeCodeSession } from './claude-code-runner.js';
import { accountManager } from './account-manager.js';

// Track if rotation callback is registered
let rotationCallbackRegistered = false;

/**
 * Initialize the spawner - registers rotation callback with session adapter
 */
function ensureRotationCallbackRegistered(): void {
  if (rotationCallbackRegistered) return;
  
  // Register rotation callback for mid-session rate limits
  sdkSessionAdapter.onRotationRequest(async (taskId, sessionId, reason, statusCode) => {
    const task = taskManager.getTask(taskId);
    if (!task) {
      return { rotated: false };
    }

    console.error(`[sdk-spawner] Rotation requested for task ${taskId} (session ${sessionId}): ${reason}`);

    // Try to rotate to next account
    const rotationResult = await sdkClientManager.rotateOnError(task.cwd ?? process.cwd(), reason);
    
    if (!rotationResult.success) {
      console.error(`[sdk-spawner] Rotation failed: ${rotationResult.error}`);
      return { rotated: false };
    }

    // Try to resume session with new account
    try {
      const newSession = await sdkClientManager.resumeSession(task.cwd ?? process.cwd(), sessionId);
      console.error(`[sdk-spawner] Successfully rotated and resumed session ${sessionId}`);
      return { rotated: true, newSession };
    } catch (err) {
      console.error(`[sdk-spawner] Failed to resume session after rotation:`, err);
      return { rotated: false };
    }
  });

  rotationCallbackRegistered = true;
  console.error('[sdk-spawner] Rotation callback registered');
}

/**
 * Spawn a new Copilot task using the SDK.
 */
export async function spawnCopilotTask(options: SpawnOptions): Promise<string> {
  // Ensure rotation callback is registered
  ensureRotationCallbackRegistered();
  
  const prompt = options.prompt?.trim() || '';

  // Use provided cwd, or client's first root, or server cwd as fallback
  const cwd = options.cwd && existsSync(options.cwd)
    ? options.cwd
    : clientContext.getDefaultCwd();

  const model = resolveModel(options.model, options.taskType);

  // Create the task in the task manager
  const task = taskManager.createTask(prompt, cwd, model, {
    autonomous: options.autonomous ?? true,
    isResume: !!options.resumeSessionId,
    retryInfo: options.retryInfo,
    dependsOn: options.dependsOn,
    labels: options.labels,
    provider: 'copilot',
    fallbackAttempted: options.fallbackAttempted,
    switchAttempted: options.switchAttempted,
    timeout: options.timeout,
  });

  // If task is waiting for dependencies, don't start execution yet
  if (task.status === TaskStatus.WAITING) {
    console.error(`[sdk-spawner] Task ${task.id} waiting for dependencies: ${task.dependsOn?.join(', ')}`);
    return task.id;
  }

  // Check if any Copilot accounts are available before starting
  const currentToken = accountManager.getCurrentToken();
  if (!currentToken) {
    console.log(`[sdk-spawner] No Copilot accounts available for task ${task.id}, using Claude Agent SDK`);
    setImmediate(() => {
      const timeout = options.timeout ?? TASK_TIMEOUT_DEFAULT_MS;
      runClaudeCodeSession(task.id, prompt, cwd, timeout).catch((err) => {
        console.error(`[sdk-spawner] Claude Code session error:`, err);
      });
    });
    return task.id;
  }

  // Execute the task asynchronously with Copilot
  setImmediate(() => {
    runSDKSession(task.id, prompt, cwd, model, options).catch((err) => {
      console.error(`[sdk-spawner] Task ${task.id} execution error:`, err);
      // Only update if not already in terminal state (adapter might have handled it)
      const currentTask = taskManager.getTask(task.id);
      if (currentTask && !isTerminalStatus(currentTask.status)) {
        taskManager.updateTask(task.id, {
          status: TaskStatus.FAILED,
          endTime: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          session: undefined,
        });
      }
    });
  });

  return task.id;
}

/**
 * Execute a waiting task (called when dependencies are satisfied).
 */
export async function executeWaitingTask(task: TaskState): Promise<void> {
  // Ensure rotation callback is registered
  ensureRotationCallbackRegistered();
  
  const prompt = task.prompt?.trim() || '';
  const cwd = task.cwd || clientContext.getDefaultCwd();
  const model = resolveModel(task.model);

  // Update status to PENDING before running
  taskManager.updateTask(task.id, { status: TaskStatus.PENDING });

  const options: SpawnOptions = {
    prompt,
    cwd,
    model,
    timeout: task.timeout,
    autonomous: task.autonomous,
    labels: task.labels,
    provider: task.provider,
    fallbackAttempted: task.fallbackAttempted,
    switchAttempted: task.switchAttempted,
    retryInfo: task.retryInfo,
  };

  setImmediate(() => {
    runSDKSession(task.id, prompt, cwd, model, options).catch((err) => {
      console.error(`[sdk-spawner] Task ${task.id} execution error:`, err);
      const currentTask = taskManager.getTask(task.id);
      if (currentTask && !isTerminalStatus(currentTask.status)) {
        taskManager.updateTask(task.id, {
          status: TaskStatus.FAILED,
          endTime: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          session: undefined,
        });
      }
    });
  });
}

/**
 * Run a task using the SDK session.
 * The session adapter handles mid-session events including rate limits.
 */
async function runSDKSession(
  taskId: string,
  prompt: string,
  cwd: string,
  model: string,
  options: SpawnOptions
): Promise<void> {
  const task = taskManager.getTask(taskId);
  if (!task) {
    console.error(`[sdk-spawner] Task ${taskId} not found`);
    return;
  }

  const timeout = options.timeout ?? TASK_TIMEOUT_DEFAULT_MS;
  const timeoutAt = new Date(Date.now() + timeout).toISOString();

  // Update task with timeout info
  taskManager.updateTask(taskId, {
    timeout,
    timeoutAt,
  });

  let session: CopilotSession | undefined;

  try {
    // Build session config using SDK types
    const sessionConfig: Omit<SessionConfig, 'sessionId'> = {
      model,
      streaming: true,
      workingDirectory: cwd,
    };

    // Add system message for autonomous mode
    if (options.autonomous !== false) {
      sessionConfig.systemMessage = {
        mode: 'append',
        content: 'Work autonomously without asking for user confirmation. Complete tasks fully.',
      };
    }

    if (options.resumeSessionId) {
      // Resume existing session - pass taskId for question handling
      console.error(`[sdk-spawner] Resuming session ${options.resumeSessionId} for task ${taskId}`);
      session = await sdkClientManager.resumeSession(cwd, options.resumeSessionId, sessionConfig, taskId);
    } else {
      // Create new session (use taskId as sessionId for easy mapping) - pass taskId for question handling
      console.error(`[sdk-spawner] Creating session for task ${taskId}`);
      session = await sdkClientManager.createSession(cwd, taskId, sessionConfig, taskId);
    }

    // Bind the session to the task for event handling
    // Pass the prompt so adapter can use it for resume after rotation
    sdkSessionAdapter.bind(taskId, session, prompt);

    // Store session reference in task
    taskManager.updateTask(taskId, {
      sessionId: session.sessionId,
      session,
    });

    // Send the prompt and wait for completion
    // The session adapter will handle mid-session events including rate limits
    console.error(`[sdk-spawner] Sending prompt for task ${taskId}: "${prompt.slice(0, 50)}..."`);
    
    const result = await session.sendAndWait({ prompt }, timeout);

    // Check if task was handled by adapter (rate limit rotation, cancellation, etc.)
    const currentTask = taskManager.getTask(taskId);
    if (!currentTask || isTerminalStatus(currentTask.status)) {
      console.error(`[sdk-spawner] Task ${taskId} already in terminal state: ${currentTask?.status}`);
      return;
    }

    // Mark completion if still running
    if (currentTask.status === TaskStatus.RUNNING) {
      if (result?.data.content) {
        taskManager.appendOutput(taskId, `[final] ${result.data.content}`);
      }
      taskManager.updateTask(taskId, {
        status: TaskStatus.COMPLETED,
        endTime: new Date().toISOString(),
        exitCode: 0,
        session: undefined,
      });
      // Destroy session to release PTY FDs
      sdkSessionAdapter.unbind(taskId);
    }

    console.error(`[sdk-spawner] Task ${taskId} completed successfully`);

  } catch (error) {
    // Check if adapter already handled this error (e.g., via session.error event)
    const currentTask = taskManager.getTask(taskId);
    if (currentTask && isTerminalStatus(currentTask.status)) {
      console.error(`[sdk-spawner] Task ${taskId} error already handled by adapter: ${currentTask.status}`);
      return;
    }
    
    // Handle the error
    await handleSessionError(taskId, cwd, timeout, options, error);
  }
  // Note: Don't unbind in finally - adapter manages binding lifecycle
  // and may need to rebind on rotation
}

/**
 * Handle session errors including rate limits.
 * This handles errors thrown by sendAndWait that weren't caught by event handlers.
 */
async function handleSessionError(
  taskId: string,
  cwd: string,
  timeout: number,
  options: SpawnOptions,
  error: unknown
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const currentTask = taskManager.getTask(taskId);

  if (!currentTask) {
    console.error(`[sdk-spawner] Task ${taskId} not found when handling error`);
    return;
  }

  // Check if already handled by the adapter
  if (isTerminalStatus(currentTask.status)) {
    console.error(`[sdk-spawner] Task ${taskId} already in terminal state: ${currentTask.status}`);
    return;
  }

  // Check for timeout
  if (errorMessage.includes('Timeout') || errorMessage.includes('timeout')) {
    const now = Date.now();
    const elapsedMs = currentTask.startTime ? now - new Date(currentTask.startTime).getTime() : undefined;
    
    sdkSessionAdapter.markTimedOut(taskId, timeout);
    console.error(`[sdk-spawner] Task ${taskId} timed out after ${timeout}ms`);
    return;
  }

  // Extract status code from error message
  const statusCode = extractStatusCode(errorMessage);
  
  // Check for rate limit or server errors
  const isRotatableError = statusCode !== undefined && ROTATABLE_STATUS_CODES.has(statusCode);

  if (isRotatableError) {
    await handleRateLimit(taskId, cwd, errorMessage, statusCode!, options);
    return;
  }

  // Generic error - mark as failed
  taskManager.updateTask(taskId, {
    status: TaskStatus.FAILED,
    endTime: new Date().toISOString(),
    error: errorMessage,
    exitCode: 1,
    session: undefined,
  });
  
  // Clean up binding
  sdkSessionAdapter.unbind(taskId);
  
  console.error(`[sdk-spawner] Task ${taskId} failed: ${errorMessage}`);
}

/**
 * Extract HTTP status code from error message
 */
function extractStatusCode(errorMessage: string): number | undefined {
  if (/\b429\b/.test(errorMessage)) return 429;
  if (/\b500\b/.test(errorMessage)) return 500;
  if (/\b502\b/.test(errorMessage)) return 502;
  if (/\b503\b/.test(errorMessage)) return 503;
  if (/\b504\b/.test(errorMessage)) return 504;
  if (/rate.?limit/i.test(errorMessage)) return 429;
  if (/too many requests/i.test(errorMessage)) return 429;
  if (/quota/i.test(errorMessage)) return 429;
  return undefined;
}

/**
 * Handle rate limit detection using multi-account rotation.
 * This is called for errors caught by sendAndWait, not by event handlers.
 */
async function handleRateLimit(
  taskId: string,
  cwd: string,
  errorMessage: string,
  statusCode: number,
  options: SpawnOptions
): Promise<void> {
  const currentTask = taskManager.getTask(taskId);
  if (!currentTask) return;

  console.error(`[sdk-spawner] Task ${taskId} rate limited (status ${statusCode}): ${errorMessage}`);

  // Try rotating to a different account
  if (sdkClientManager.shouldRotateOnError(statusCode, errorMessage)) {
    taskManager.appendOutput(taskId, `[rate-limit] Attempting account rotation (status: ${statusCode})...`);
    
    const rotationResult = await sdkClientManager.rotateOnError(cwd, `status_${statusCode}`);
    
    if (rotationResult.success) {
      taskManager.appendOutput(taskId, `[rate-limit] Rotated to next account, retrying...`);
      
      // Retry with the new account
      try {
        // Clean up old binding first
        sdkSessionAdapter.unbind(taskId);
        
        await runSDKSession(taskId, currentTask.prompt, cwd, resolveModel(currentTask.model), {
          ...options,
          switchAttempted: true,
        });
        return;
      } catch (retryError) {
        console.error(`[sdk-spawner] Retry after rotation failed:`, retryError);
        // Fall through to exponential backoff
      }
    } else if (shouldFallbackToClaudeCode(rotationResult)) {
      // All accounts exhausted - fallback to Claude Agent SDK
      console.log(`[sdk-spawner] All Copilot accounts exhausted for task ${taskId}, falling back to Claude Agent SDK`);

      // Unbind Copilot session
      sdkSessionAdapter.unbind(taskId);

      // Mark task as switching provider
      taskManager.appendOutput(taskId, '\n[system] All Copilot accounts exhausted. Switching to Claude Agent SDK...\n');

      // Build handoff prompt from session snapshot
      const handoffPrompt = buildHandoffPrompt(currentTask, 5);

      // Calculate remaining timeout
      const elapsed = Date.now() - new Date(currentTask.startTime).getTime();
      const taskTimeout = currentTask.timeout ?? TASK_TIMEOUT_DEFAULT_MS;
      const timeoutRemaining = Math.max(1000, taskTimeout - elapsed);

      // Continue with Claude Agent SDK
      await runClaudeCodeSession(taskId, handoffPrompt, cwd, timeoutRemaining);
      return;
    }
  }

  // Enter exponential backoff
  const retryInfo = createRetryInfo(currentTask, errorMessage, currentTask.retryInfo);
  
  taskManager.updateTask(taskId, {
    status: TaskStatus.RATE_LIMITED,
    endTime: new Date().toISOString(),
    error: errorMessage,
    retryInfo,
    session: undefined,
  });

  sdkSessionAdapter.unbind(taskId);
  console.error(`[sdk-spawner] Task ${taskId} rate-limited, scheduled retry #${retryInfo.retryCount} at ${retryInfo.nextRetryTime}`);
}

/**
 * Cancel a running task by aborting its session.
 */
export async function cancelTask(taskId: string): Promise<boolean> {
  const task = taskManager.getTask(taskId);
  if (!task) {
    return false;
  }

  // Update status first
  taskManager.updateTask(taskId, {
    status: TaskStatus.CANCELLED,
    endTime: new Date().toISOString(),
    session: undefined,
  });

  // Try to abort the SDK session
  const session = sdkSessionAdapter.getSession(taskId);
  if (session) {
    try {
      await session.abort();
      console.error(`[sdk-spawner] Aborted session for task ${taskId}`);
    } catch (err) {
      console.error(`[sdk-spawner] Failed to abort session for ${taskId}:`, err);
    }
  }

  // Clean up binding (this also destroys the session and removes from client tracking)
  sdkSessionAdapter.unbind(taskId);

  // Also try to destroy via client manager directly in case unbind missed it
  await sdkClientManager.destroySession(taskId).catch(() => {});

  return true;
}

/**
 * Check if the SDK client can be initialized (Copilot CLI is available).
 */
export async function checkSDKAvailable(): Promise<boolean> {
  try {
    // Initialize rotation callback
    ensureRotationCallbackRegistered();
    
    const client = await sdkClientManager.getClient(process.cwd());
    const status = await client.getStatus();
    return !!status.version;
  } catch {
    return false;
  }
}

/**
 * Get SDK client statistics.
 */
export function getSDKStats(): { 
  pools: number; 
  clients: number; 
  sessions: number; 
  bindings: number;
  rotations: number;
} {
  const clientStats = sdkClientManager.getStats();
  const adapterStats = sdkSessionAdapter.getStats();
  return {
    ...clientStats,
    bindings: adapterStats.activeBindings,
    rotations: adapterStats.totalRotations,
  };
}

/**
 * Shutdown the SDK gracefully.
 */
export async function shutdownSDK(): Promise<void> {
  sdkSessionAdapter.cleanup();
  await sdkClientManager.shutdown();
}
