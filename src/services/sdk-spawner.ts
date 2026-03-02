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
import { realpath as realpathAsync } from 'fs/promises';
import { taskManager } from './task-manager.js';
import { clientContext } from './client-context.js';
import { sdkClientManager } from './sdk-client-manager.js';
import { sdkSessionAdapter } from './sdk-session-adapter.js';
import { TaskStatus, type SpawnOptions, type TaskState, isTerminalStatus, ROTATABLE_STATUS_CODES } from '../types.js';
import { resolveModel } from '../models.js';
import { createRetryInfo } from './retry-queue.js';
import { TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';
import { shouldFallbackToClaudeCode, isFallbackEnabled } from './exhaustion-fallback.js';
import { abortClaudeCodeSession } from './claude-code-runner.js';
import { triggerClaudeFallback } from './fallback-orchestrator.js';
import { accountManager } from './account-manager.js';
import { processRegistry } from './process-registry.js';

// Track if rotation callback is registered
let rotationCallbackRegistered = false;

function extractRateLimitMetadata(errorMessage?: string): { retryAfter?: string; rateLimitReset?: string } {
  if (!errorMessage) {
    return {};
  }

  const retryAfterMatch = errorMessage.match(
    /retry-?after[^0-9A-Za-z]+(\d{1,8}|[A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i
  );
  const rateLimitResetMatch = errorMessage.match(/x-?ratelimit-?reset[^0-9]+(\d{10,13})\b/i);

  return {
    retryAfter: retryAfterMatch?.[1],
    rateLimitReset: rateLimitResetMatch?.[1],
  };
}

function buildRotationReason(statusCode: number | undefined, baseReason: string, errorMessage?: string): string {
  const reasonBase = statusCode !== undefined ? `status_${statusCode}` : baseReason;
  const metadata = extractRateLimitMetadata(errorMessage);
  const parts = [reasonBase];

  if (metadata.retryAfter) {
    parts.push(`retry-after=${metadata.retryAfter}`);
  }
  if (metadata.rateLimitReset) {
    parts.push(`x-ratelimit-reset=${metadata.rateLimitReset}`);
  }

  return parts.join(' | ');
}

function buildAllAccountsExhaustedMessage(rotationError?: string): string {
  const detail = rotationError ? ` Details: ${rotationError}` : '';
  return `All Copilot accounts are temporarily rate limited.${detail} Claude fallback is disabled (DISABLE_CLAUDE_CODE_FALLBACK=true). Wait for cooldown and retry, or enable fallback.`;
}

function extractSessionPid(session: CopilotSession): number | undefined {
  const candidate = session as unknown as {
    cliProcess?: { pid?: unknown };
    childProcess?: { pid?: unknown };
    process?: { pid?: unknown };
    pid?: unknown;
  };
  const rawPid =
    candidate.cliProcess?.pid ??
    candidate.childProcess?.pid ??
    candidate.process?.pid ??
    candidate.pid;
  return typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
}

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
    const rotationReason = buildRotationReason(statusCode, reason, task.failureContext?.message);
    const failedTokenIndex = sdkClientManager.getSessionTokenIndex(sessionId);
    const rotationResult = await sdkClientManager.rotateOnError(task.cwd ?? process.cwd(), rotationReason, failedTokenIndex);
    
    if (!rotationResult.success) {
      if (rotationResult.allExhausted && !isFallbackEnabled()) {
        const actionableMessage = buildAllAccountsExhaustedMessage(rotationResult.error);
        taskManager.appendOutput(taskId, `[rate-limit] ${actionableMessage}`);
        taskManager.updateTask(taskId, {
          status: TaskStatus.FAILED,
          endTime: new Date().toISOString(),
          error: actionableMessage,
          exitCode: 1,
          session: undefined,
        });
        sdkSessionAdapter.unbind(taskId);
        console.error(`[sdk-spawner] Task ${taskId} failed fast during rotation callback: ${actionableMessage}`);
      }
      console.error(`[sdk-spawner] Rotation failed: ${rotationResult.error}`);
      return { rotated: false };
    }

    const taskAfterRotate = taskManager.getTask(taskId);
    if (!taskAfterRotate || isTerminalStatus(taskAfterRotate.status)) {
      await sdkClientManager.destroySession(sessionId).catch(() => {});
      console.error(`[sdk-spawner] Task ${taskId} became ${taskAfterRotate?.status ?? 'deleted'} during rotation callback`);
      return { rotated: false };
    }

    // Try to resume session with new account
    try {
      const newSession = await sdkClientManager.resumeSession(task.cwd ?? process.cwd(), sessionId, undefined, taskId);
      const taskAfterResume = taskManager.getTask(taskId);
      if (!taskAfterResume || isTerminalStatus(taskAfterResume.status)) {
        await sdkClientManager.destroySession(newSession.sessionId).catch(() => {});
        console.error(`[sdk-spawner] Task ${taskId} became ${taskAfterResume?.status ?? 'deleted'} after resume`);
        return { rotated: false };
      }
      console.error(`[sdk-spawner] Successfully rotated and resumed session ${sessionId}`);
      return { rotated: true, newSession };
    } catch (err) {
      console.error(`[sdk-spawner] Failed to resume session after rotation:`, err);
      await sdkClientManager.destroySession(sessionId).catch(() => {});
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
  const workspaceRoot = clientContext.getDefaultCwd();
  let cwd = workspaceRoot;
  if (options.cwd && existsSync(options.cwd)) {
    // Validate CWD is within workspace root to prevent CWD escape (security)
    try {
      const resolvedCwd = await realpathAsync(options.cwd);
      const resolvedRoot = await realpathAsync(workspaceRoot);
      if (resolvedCwd.startsWith(resolvedRoot + '/') || resolvedCwd === resolvedRoot) {
        cwd = options.cwd;
      } else {
        console.error(`[sdk-spawner] CWD "${options.cwd}" is outside workspace root "${workspaceRoot}", using workspace root`);
      }
    } catch {
      console.error(`[sdk-spawner] Failed to resolve CWD "${options.cwd}", using workspace root`);
    }
  }

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

  // Extract task ID to avoid capturing the full TaskState object in closures below.
  // This prevents the setImmediate callbacks from holding a reference to the
  // (potentially large) TaskState and its nested session/metrics objects.
  const taskId = task.id;

  // Check if any Copilot accounts are available before starting
  const currentToken = accountManager.getCurrentToken();
  if (!currentToken) {
    if (!isFallbackEnabled()) {
      console.error(`[sdk-spawner] No Copilot accounts available and Claude fallback is disabled`);
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        error: 'No Copilot accounts configured and Claude fallback is disabled (DISABLE_CLAUDE_CODE_FALLBACK=true)',
        endTime: new Date().toISOString(),
        exitCode: 1,
      });
      return taskId;
    }
    console.error(`[sdk-spawner] No Copilot accounts available for task ${taskId}, using Claude Agent SDK`);
    setImmediate(() => {
      // Guard: task may have been cancelled/failed between creation and callback
      const current = taskManager.getTask(taskId);
      if (!current || isTerminalStatus(current.status)) return;

      triggerClaudeFallback(taskId, {
        reason: 'copilot_startup_no_accounts',
        promptOverride: prompt,
        cwd,
      }).catch((err) => {
        console.error(`[sdk-spawner] Claude fallback error:`, err);
      });
    });
    return taskId;
  }

  // Execute the task asynchronously with Copilot
  setImmediate(() => {
    // Guard: task may have been cancelled/failed between creation and callback
    const current = taskManager.getTask(taskId);
    if (!current || isTerminalStatus(current.status)) return;

    runSDKSession(taskId, prompt, cwd, model, options).catch((err) => {
      console.error(`[sdk-spawner] Task ${taskId} execution error:`, err);
      // Only update if not already in terminal state (adapter might have handled it)
      const currentTask = taskManager.getTask(taskId);
      if (currentTask && !isTerminalStatus(currentTask.status)) {
        if (isFallbackEnabled()) {
          console.error(`[sdk-spawner] Task ${taskId} unhandled error, falling back to Claude Agent SDK`);
          sdkSessionAdapter.unbind(taskId);
          triggerClaudeFallback(taskId, {
            reason: 'copilot_unhandled_error',
            errorMessage: err instanceof Error ? err.message : String(err),
            promptOverride: prompt,
            cwd,
          }).catch((fallbackErr) => {
            console.error(`[sdk-spawner] Claude fallback also failed:`, fallbackErr);
          });
        } else {
          taskManager.updateTask(taskId, {
            status: TaskStatus.FAILED,
            endTime: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
            session: undefined,
          });
        }
      }
    });
  });

  return taskId;
}

/**
 * Execute a waiting task (called when dependencies are satisfied).
 */
export async function executeWaitingTask(task: TaskState): Promise<void> {
  // Ensure rotation callback is registered
  ensureRotationCallbackRegistered();

  // Extract primitives/strings from the TaskState to avoid capturing the full
  // object (and its session/metrics references) in the setImmediate closure.
  const taskId = task.id;
  const prompt = task.prompt?.trim() || '';
  const cwd = task.cwd || clientContext.getDefaultCwd();
  const model = resolveModel(task.model);

  // Update status to PENDING before running
  taskManager.updateTask(taskId, { status: TaskStatus.PENDING });

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
    // Guard: task may have been cancelled/failed while waiting for this callback
    const current = taskManager.getTask(taskId);
    if (!current || isTerminalStatus(current.status)) return;

    runSDKSession(taskId, prompt, cwd, model, options).catch((err) => {
      console.error(`[sdk-spawner] Task ${taskId} execution error:`, err);
      const currentTask = taskManager.getTask(taskId);
      if (currentTask && !isTerminalStatus(currentTask.status)) {
        if (isFallbackEnabled()) {
          console.error(`[sdk-spawner] Task ${taskId} unhandled error, falling back to Claude Agent SDK`);
          sdkSessionAdapter.unbind(taskId);
          triggerClaudeFallback(taskId, {
            reason: 'copilot_unhandled_error',
            errorMessage: err instanceof Error ? err.message : String(err),
            promptOverride: prompt,
            cwd,
          }).catch((fallbackErr) => {
            console.error(`[sdk-spawner] Claude fallback also failed:`, fallbackErr);
          });
        } else {
          taskManager.updateTask(taskId, {
            status: TaskStatus.FAILED,
            endTime: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
            session: undefined,
          });
        }
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

  if (task.status !== TaskStatus.PENDING) {
    console.error(`[sdk-spawner] Task ${taskId} is ${task.status}, expected PENDING — skipping session creation`);
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
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.8,
        bufferExhaustionThreshold: 0.95,
      },
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

    // Store reference immediately to prevent orphan if bind() throws
    taskManager.updateTask(taskId, {
      sessionId: session.sessionId,
      session,
    });

    processRegistry.register({
      taskId,
      pid: extractSessionPid(session),
      session,
      registeredAt: Date.now(),
      label: 'copilot-session',
    });

    // Bind the session to the task for event handling
    // Pass the prompt so adapter can use it for resume after rotation
    sdkSessionAdapter.bind(taskId, session, prompt);

    // Send the prompt — completion is handled by the session adapter via
    // session.idle event (handleSessionIdle). Using send() instead of
    // sendAndWait() avoids a double-completion race where both sendAndWait's
    // internal handler and the adapter compete to mark COMPLETED and destroy
    // the session.
    console.error(`[sdk-spawner] Sending prompt for task ${taskId}: "${prompt.slice(0, 50)}..."`);
    
    await session.send({ prompt });

    console.error(`[sdk-spawner] Prompt sent for task ${taskId}, adapter will handle completion`);

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
 * This handles errors thrown by session.send() (e.g., connection failures)
 * that aren't caught by the adapter's session.error event handler.
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

  // Non-rotatable error — check if we should fallback to Claude Agent SDK
  // CLI crashes, auth errors, and other unrecoverable errors should fallback
  // rather than just marking FAILED (the user gets nothing otherwise)
  if (isFallbackEnabled()) {
    console.error(`[sdk-spawner] Task ${taskId} hit non-rotatable error, falling back to Claude Agent SDK`);

    const session = sdkSessionAdapter.getSession(taskId);
    sdkSessionAdapter.unbind(taskId);
    const started = await triggerClaudeFallback(taskId, {
      reason: 'copilot_non_rotatable_error',
      errorMessage,
      session,
      cwd,
      awaitCompletion: true,
    });
    if (started) {
      return;
    }
    return;
  }

  // Fallback disabled — mark as failed
  taskManager.updateTask(taskId, {
    status: TaskStatus.FAILED,
    endTime: new Date().toISOString(),
    error: errorMessage,
    exitCode: 1,
    session: undefined,
  });

  sdkSessionAdapter.unbind(taskId);
  console.error(`[sdk-spawner] Task ${taskId} failed: ${errorMessage}`);
}

/**
 * Context-aware HTTP status code patterns to avoid false positives on
 * error messages that happen to contain bare numbers like "429" or "500".
 * Structured statusCode from SDK events takes priority; this is the
 * string-fallback path only.
 */
const STATUS_CODE_PATTERNS: [RegExp, number][] = [
  [/\bstatus[\s:]+429\b/i, 429],
  [/\b429\s*(Too Many Requests|rate limit)/i, 429],
  [/\bHTTP[\/\s]\d+\.\d+\s+429\b/i, 429],
  [/\bstatus[\s:]+5\d{2}\b/i, 500],
  [/\bstatus[\s:]+502\b/i, 502],
  [/\bstatus[\s:]+503\b/i, 503],
  [/\bstatus[\s:]+504\b/i, 504],
  [/\bHTTP[\/\s]\d+\.\d+\s+5\d{2}\b/i, 500],
];

/**
 * Extract HTTP status code from error message using context-aware patterns.
 * Semantic phrases (rate limit, too many requests, quota) are still matched
 * as a last resort to catch non-standard error formats.
 */
function extractStatusCode(errorMessage: string): number | undefined {
  for (const [pattern, code] of STATUS_CODE_PATTERNS) {
    if (pattern.test(errorMessage)) return code;
  }
  if (/rate.?limit/i.test(errorMessage)) return 429;
  if (/too many requests/i.test(errorMessage)) return 429;
  if (/quota/i.test(errorMessage)) return 429;
  return undefined;
}

/**
 * Handle rate limit detection using multi-account rotation.
 * This is called for connection-level errors caught by session.send().
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
  const currentSessionId = currentTask.sessionId;

  console.error(`[sdk-spawner] Task ${taskId} rate limited (status ${statusCode}): ${errorMessage}`);

  // Try rotating to a different account
  if (sdkClientManager.shouldRotateOnError(statusCode, errorMessage)) {
    taskManager.appendOutput(taskId, `[rate-limit] Attempting account rotation (status: ${statusCode})...`);
    
    const rotationReason = buildRotationReason(statusCode, `status_${statusCode}`, errorMessage);
    const failedTokenIndex = currentTask.sessionId ? sdkClientManager.getSessionTokenIndex(currentTask.sessionId) : undefined;
    const rotationResult = await sdkClientManager.rotateOnError(cwd, rotationReason, failedTokenIndex);
    
    if (rotationResult.success) {
      taskManager.appendOutput(taskId, `[rate-limit] Rotated to next account, retrying...`);
      const taskAfterRotate = taskManager.getTask(taskId);
      if (!taskAfterRotate || isTerminalStatus(taskAfterRotate.status)) {
        if (currentSessionId) {
          await sdkClientManager.destroySession(currentSessionId).catch(() => {});
        }
        console.error(`[sdk-spawner] Task ${taskId} became ${taskAfterRotate?.status ?? 'deleted'} before retry`);
        return;
      }
      
      // Retry with the new account
      try {
        // Clean up old binding first
        sdkSessionAdapter.unbind(taskId);
        
        await runSDKSession(taskId, taskAfterRotate.prompt, cwd, resolveModel(taskAfterRotate.model), {
          ...options,
          switchAttempted: true,
        });
        return;
      } catch (retryError) {
        console.error(`[sdk-spawner] Retry after rotation failed:`, retryError);
        // Fall through to exponential backoff
      }
    } else if (rotationResult.allExhausted && !isFallbackEnabled()) {
      const actionableMessage = buildAllAccountsExhaustedMessage(rotationResult.error);
      taskManager.appendOutput(taskId, `[rate-limit] ${actionableMessage}`);
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: actionableMessage,
        exitCode: 1,
        session: undefined,
      });
      sdkSessionAdapter.unbind(taskId);
      console.error(`[sdk-spawner] Task ${taskId} failed fast: ${actionableMessage}`);
      return;
    } else if (shouldFallbackToClaudeCode(rotationResult)) {
      // All accounts exhausted - fallback to Claude Agent SDK
      console.error(`[sdk-spawner] All Copilot accounts exhausted for task ${taskId}, falling back to Claude Agent SDK`);

      const session = sdkSessionAdapter.getSession(taskId);
      const started = await triggerClaudeFallback(taskId, {
        reason: 'copilot_accounts_exhausted',
        errorMessage: 'All Copilot accounts exhausted',
        session,
        cwd,
        awaitCompletion: true,
      });
      if (started) {
        sdkSessionAdapter.unbind(taskId);
        return;
      }
    }
  }

  // Copilot rate-limited and rotation path did not yield a runnable session.
  if (isFallbackEnabled()) {
    const session = sdkSessionAdapter.getSession(taskId);
    const started = await triggerClaudeFallback(taskId, {
      reason: 'copilot_rate_limited',
      errorMessage,
      session,
      cwd,
      awaitCompletion: true,
    });
    if (started) {
      sdkSessionAdapter.unbind(taskId);
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
