/**
 * SDK Session Adapter - Bridges Copilot SDK sessions to the MCP server's TaskState model.
 * 
 * This adapter:
 * - Maps SDK session events to TaskState updates using SDK's native types
 * - Handles mid-session rate limit detection via session.error events
 * - Triggers account rotation and session resume on rate limits
 * - Manages streaming output accumulation
 * - Provides unified error handling with proper typing
 * - Collects completion metrics from session.shutdown
 * - Tracks quota info from assistant.usage
 * - Monitors tool execution and subagent activity
 */

import type { CopilotSession } from '@github/copilot-sdk';
import type { SessionEvent } from '@github/copilot-sdk';
import type { MessageOptions } from '@github/copilot-sdk';
import { taskManager, TERMINAL_STATUSES } from './task-manager.js';
import { sdkClientManager } from './sdk-client-manager.js';
import { clearTaskToolMetrics } from './session-hooks.js';
import { 
  TaskStatus, 
  type RetryInfo,
  type FailureContext,
  type CompletionMetrics,
  type QuotaInfo,
  type ToolMetrics,
  type SubagentInfo,
  type SessionMetrics,
} from '../types.js';

// Extract specific event types from the union for type-safe handling
type SessionErrorEvent = Extract<SessionEvent, { type: 'session.error' }>;
type SessionIdleEvent = Extract<SessionEvent, { type: 'session.idle' }>;
type SessionShutdownEvent = Extract<SessionEvent, { type: 'session.shutdown' }>;
type AssistantMessageDeltaEvent = Extract<SessionEvent, { type: 'assistant.message_delta' }>;
type AssistantMessageEvent = Extract<SessionEvent, { type: 'assistant.message' }>;
type AssistantUsageEvent = Extract<SessionEvent, { type: 'assistant.usage' }>;
type ToolExecutionStartEvent = Extract<SessionEvent, { type: 'tool.execution_start' }>;
type ToolExecutionCompleteEvent = Extract<SessionEvent, { type: 'tool.execution_complete' }>;
type SubagentStartedEvent = Extract<SessionEvent, { type: 'subagent.started' }>;
type SubagentCompletedEvent = Extract<SessionEvent, { type: 'subagent.completed' }>;
type SubagentFailedEvent = Extract<SessionEvent, { type: 'subagent.failed' }>;
type AssistantTurnStartEvent = Extract<SessionEvent, { type: 'assistant.turn_start' }>;

// Error status codes that should trigger rotation
const ROTATABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_STATUS_CODE = 429;

// String-based rate limit detection fallback
const RATE_LIMIT_STRING = "Sorry, you've hit a rate limit that restricts the number of Copilot model requests";

// Health check model for testing account availability
const HEALTH_CHECK_MODEL = 'claude-haiku-4.5';

/**
 * Check if a status is terminal (no further state changes expected).
 * RATE_LIMITED is NOT terminal — the retry system can still update these tasks.
 */
function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// Callback type for rotation requests
type RotationRequestCallback = (
  taskId: string,
  sessionId: string,
  reason: string,
  statusCode?: number
) => Promise<{ rotated: boolean; newSession?: CopilotSession }>;

// Type for quota snapshot from SDK
interface QuotaSnapshot {
  remainingPercentage: number;
  usedRequests?: number;
  entitlementRequests?: number;
  isUnlimitedEntitlement?: boolean;
  overage?: number;
  resetDate?: string;
}

// Type for model metrics from SDK
interface ModelMetricsData {
  requests?: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface SessionBinding {
  taskId: string;
  session: CopilotSession;
  sessionId: string;
  unsubscribe: () => void;
  outputBuffer: string[];
  lastMessageId?: string;
  startTime: Date;
  isCompleted: boolean;
  isPaused: boolean;
  error?: string;
  rotationAttempts: number;
  maxRotationAttempts: number;
  rotationInProgress: boolean;
  rateLimitInfo?: {
    statusCode: number;
    resetDate?: string;
    remainingPercentage?: number;
  };
  pendingPrompt?: string;
  // Aggregated metrics (replaces UsageMetricsTracker which is not exported by SDK)
  // Enhanced metrics tracking
  turnCount: number;
  totalTokens: { input: number; output: number };
  toolMetrics: Map<string, ToolMetrics>;
  toolStartTimes: Map<string, number>;
  toolCallIdToName: Map<string, string>; // METRIC-1: Track toolCallId → toolName for accurate completion matching
  activeSubagents: Map<string, SubagentInfo>;
  completedSubagents: SubagentInfo[];
  quotas: Map<string, QuotaInfo>;
}

class SDKSessionAdapter {
  private bindings: Map<string, SessionBinding> = new Map();
  private rotationCallback?: RotationRequestCallback;

  /**
   * Set the callback for rotation requests.
   * This is called when mid-session rate limits are detected.
   */
  onRotationRequest(callback: RotationRequestCallback): void {
    this.rotationCallback = callback;
  }

  /**
   * Perform a health check on the current account by creating a test session.
   * Uses claude-haiku-4.5 for fast/cheap verification.
   * Returns true if the account can successfully respond.
   */
  async performHealthCheck(cwd: string): Promise<boolean> {
    const healthCheckSessionId = `health-check-${Date.now()}`;
    try {
      console.error(`[sdk-session-adapter] Health check: Testing account with ${HEALTH_CHECK_MODEL}...`);
      const testSession = await sdkClientManager.createSession(
        cwd,
        healthCheckSessionId,
        { model: HEALTH_CHECK_MODEL }
      );

      // Send a simple test message
      await testSession.sendAndWait({ prompt: 'hi' });

      console.error(`[sdk-session-adapter] Health check passed`);
      return true;
    } catch (err) {
      console.error(`[sdk-session-adapter] Health check failed:`, err);
      return false;
    } finally {
      // Always clean up the health check session, whether it succeeded or failed
      await sdkClientManager.destroySession(healthCheckSessionId).catch(() => {});
    }
  }

  /**
   * Bind a SDK session to a task, setting up event handlers.
   */
  bind(taskId: string, session: CopilotSession, pendingPrompt?: string): void {
    // Clean up any existing binding
    this.unbind(taskId);

    const startTime = new Date();
    const binding: SessionBinding = {
      taskId,
      session,
      sessionId: session.sessionId,
      unsubscribe: () => {},
      outputBuffer: [],
      startTime,
      isCompleted: false,
      isPaused: false,
      rotationAttempts: 0,
      maxRotationAttempts: 10,
      rotationInProgress: false,
      pendingPrompt,
      // Initialize metrics tracking
      turnCount: 0,
      totalTokens: { input: 0, output: 0 },
      toolMetrics: new Map(),
      toolStartTimes: new Map(),
      toolCallIdToName: new Map(),
      activeSubagents: new Map(),
      completedSubagents: [],
      quotas: new Map(),
    };

    // Subscribe to all session events using SDK's typed event system
    const unsubscribe = session.on((event: SessionEvent) => {
      this.handleEvent(taskId, event, binding).catch((err) => {
        console.error(`[sdk-session-adapter] Error handling event ${event.type} for task ${taskId}:`, err);
      });
    });

    binding.unsubscribe = unsubscribe;
    this.bindings.set(taskId, binding);

    // Initialize session metrics in task
    taskManager.updateTask(taskId, {
      status: TaskStatus.RUNNING,
      sessionId: session.sessionId,
      session,
      sessionMetrics: {
        quotas: {},
        toolMetrics: {},
        activeSubagents: [],
        completedSubagents: [],
        turnCount: 0,
        totalTokens: { input: 0, output: 0 },
      },
    });

    console.error(`[sdk-session-adapter] Bound session ${session.sessionId} to task ${taskId}`);
  }

  /**
   * Handle SDK session events and map them to task updates.
   * Uses type narrowing for type-safe event handling.
   */
  private async handleEvent(taskId: string, event: SessionEvent, binding: SessionBinding): Promise<void> {
    const task = taskManager.getTask(taskId);
    if (!task) {
      console.error(`[sdk-session-adapter] Task ${taskId} not found for event ${event.type}`);
      return;
    }

    // Skip events if session is paused (during rotation)
    if (binding.isPaused && event.type !== 'session.error') {
      return;
    }

    switch (event.type) {
      case 'session.start':
        this.handleSessionStart(taskId, event);
        break;

      case 'session.resume':
        taskManager.appendOutput(taskId, `[session] Resumed at ${event.data.resumeTime}`);
        binding.isPaused = false; // Clear pause state on resume
        break;

      case 'session.idle':
        this.handleSessionIdle(taskId, event as SessionIdleEvent, binding);
        break;

      case 'session.error':
        await this.handleSessionError(taskId, event as SessionErrorEvent, binding);
        break;

      case 'assistant.turn_start':
        this.handleTurnStart(taskId, event as AssistantTurnStartEvent, binding);
        break;

      case 'assistant.message_delta':
        this.handleMessageDelta(taskId, event as AssistantMessageDeltaEvent, binding);
        break;

      case 'assistant.message':
        await this.handleAssistantMessage(taskId, event as AssistantMessageEvent, binding);
        break;

      case 'assistant.reasoning':
        taskManager.appendOutput(taskId, `[reasoning] ${event.data.content}`);
        break;

      case 'assistant.reasoning_delta':
        taskManager.appendOutput(taskId, `[reasoning] ${event.data.deltaContent}`);
        break;

      case 'assistant.turn_end':
        taskManager.appendOutput(taskId, `[assistant] Turn ended: ${event.data.turnId}`);
        break;

      case 'assistant.usage':
        this.handleUsage(taskId, event as AssistantUsageEvent, binding);
        break;

      case 'tool.execution_start':
        this.handleToolStart(taskId, event as ToolExecutionStartEvent, binding);
        break;

      case 'tool.execution_progress':
        taskManager.appendOutput(taskId, `[tool] Progress: ${event.data.progressMessage}`);
        break;

      case 'tool.execution_complete':
        this.handleToolComplete(taskId, event as ToolExecutionCompleteEvent, binding);
        break;

      case 'subagent.started':
        this.handleSubagentStarted(taskId, event as SubagentStartedEvent, binding);
        break;

      case 'subagent.completed':
        this.handleSubagentCompleted(taskId, event as SubagentCompletedEvent, binding);
        break;

      case 'subagent.failed':
        this.handleSubagentFailed(taskId, event as SubagentFailedEvent, binding);
        break;

      case 'session.compaction_start':
        taskManager.appendOutput(taskId, `[session] Context compaction started`);
        break;

      case 'session.compaction_complete':
        if (event.data.success) {
          taskManager.appendOutput(taskId, `[session] Compaction complete: removed ${event.data.tokensRemoved} tokens`);
        } else {
          taskManager.appendOutput(taskId, `[session] Compaction failed: ${event.data.error}`);
        }
        break;

      case 'session.shutdown':
        this.handleSessionShutdown(taskId, event as SessionShutdownEvent, binding);
        break;

      case 'abort':
        this.handleAbort(taskId, event, binding);
        break;

      case 'user.message':
        // User message sent - log truncated version
        const content = event.data.content;
        taskManager.appendOutput(taskId, `[user] ${content.length > 100 ? content.slice(0, 100) + '...' : content}`);
        break;

      default:
        // Log other events in debug mode
        if (process.env.DEBUG_SDK_EVENTS === 'true') {
          console.error(`[sdk-session-adapter] Event: ${event.type}`);
        }
    }
  }

  /**
   * Handle session.start event
   */
  private handleSessionStart(taskId: string, event: Extract<SessionEvent, { type: 'session.start' }>): void {
    taskManager.appendOutput(taskId, `[session] Started: ${event.data.sessionId}`);
    if (event.data.selectedModel) {
      taskManager.appendOutput(taskId, `[session] Model: ${event.data.selectedModel}`);
    }
    if (event.data.context?.cwd) {
      taskManager.appendOutput(taskId, `[session] CWD: ${event.data.context.cwd}`);
    }
  }

  /**
   * Handle assistant.turn_start event - track turn count
   */
  private handleTurnStart(taskId: string, event: AssistantTurnStartEvent, binding: SessionBinding): void {
    binding.turnCount++;
    taskManager.appendOutput(taskId, `[assistant] Turn ${binding.turnCount} started: ${event.data.turnId}`);
    
    // Update session metrics
    this.updateSessionMetrics(taskId, binding);
  }

  /**
   * Handle session.idle event - indicates completion
   */
  private handleSessionIdle(taskId: string, _event: SessionIdleEvent, binding: SessionBinding): void {
    if (!binding.isCompleted) {
      binding.isCompleted = true;
      
      // Finalize session metrics
      this.updateSessionMetrics(taskId, binding);
      
      taskManager.updateTask(taskId, {
        status: TaskStatus.COMPLETED,
        endTime: new Date().toISOString(),
        exitCode: 0,
      });
      console.error(`[sdk-session-adapter] Task ${taskId} completed (session.idle)`);
    }
  }

  /**
   * Handle session.error event - key for mid-session rate limit detection
   * Now stores structured failure context
   */
  private async handleSessionError(
    taskId: string,
    event: SessionErrorEvent,
    binding: SessionBinding
  ): Promise<void> {
    const { errorType, message, statusCode, providerCallId, stack } = event.data;

    taskManager.appendOutput(taskId, `[error] ${errorType}: ${message} (status: ${statusCode || 'unknown'})`);

    // Create structured failure context from SDK event
    const failureContext: FailureContext = {
      errorType,
      statusCode,
      providerCallId,
      message,
      stack,
      recoverable: statusCode !== undefined && ROTATABLE_STATUS_CODES.has(statusCode),
    };

    // Store failure context in task immediately
    taskManager.updateTask(taskId, { failureContext });

    // Check if this is a rotatable error (rate limit or server error)
    const isRotatableError = statusCode !== undefined && ROTATABLE_STATUS_CODES.has(statusCode);
    const isRateLimit = statusCode === RATE_LIMIT_STATUS_CODE;

    if (isRotatableError && binding.rotationAttempts < binding.maxRotationAttempts && !binding.rotationInProgress) {
      // RC-1: Guard against concurrent rotation from multiple error events
      binding.rotationInProgress = true;
      binding.isPaused = true;
      binding.rotationAttempts++;

      taskManager.appendOutput(
        taskId,
        `[rotation] Attempting account rotation (attempt ${binding.rotationAttempts}/${binding.maxRotationAttempts}) due to ${isRateLimit ? 'rate limit' : 'server error'} ${statusCode}`
      );

      try {
        // Try to rotate and resume
        const rotationSuccess = await this.attemptRotationAndResume(taskId, binding, statusCode!, message);

        if (rotationSuccess) {
          return; // Successfully rotated and resumed, don't mark as failed
        }
      } finally {
        binding.rotationInProgress = false;
      }

      // Rotation failed - fall through to handle as error
      taskManager.appendOutput(taskId, `[rotation] Rotation failed, marking task as ${isRateLimit ? 'rate_limited' : 'failed'}`);
    } else if (isRotatableError && binding.rotationInProgress) {
      // RC-1: Another error arrived while rotation is already in progress — skip
      taskManager.appendOutput(taskId, `[rotation] Rotation already in progress, ignoring duplicate error event`);
      return;
    }

    // RC-6: Re-check terminal state before marking — task may have been cancelled/completed during rotation
    const currentTask = taskManager.getTask(taskId);
    if (!currentTask || isTerminalStatus(currentTask.status)) {
      return;
    }

    // Handle based on error type
    if (isRateLimit) {
      this.markAsRateLimited(taskId, binding, message, failureContext);
    } else {
      this.markAsFailed(taskId, binding, message, statusCode, failureContext);
    }
  }

  /**
   * Attempt to rotate to a new account and resume the session
   */
  private async attemptRotationAndResume(
    taskId: string,
    binding: SessionBinding,
    statusCode: number,
    errorMessage: string
  ): Promise<boolean> {
    // First try the registered callback
    if (this.rotationCallback) {
      try {
        const result = await this.rotationCallback(
          taskId,
          binding.sessionId,
          `status_${statusCode}`,
          statusCode
        );

        // RC-2: Check terminal state after await — task may have been cancelled during rotation callback
        const taskAfterCallback = taskManager.getTask(taskId);
        if (!taskAfterCallback || isTerminalStatus(taskAfterCallback.status)) {
          console.error(`[sdk-session-adapter] Task ${taskId} became ${taskAfterCallback?.status ?? 'deleted'} during rotation callback`);
          return false;
        }

        if (result.rotated && result.newSession) {
          // Successfully rotated - rebind with new session
          await this.rebindWithNewSession(taskId, binding, result.newSession);
          return true;
        }
      } catch (err) {
        console.error(`[sdk-session-adapter] Rotation callback failed:`, err);
      }
    }

    // Try rotating via SDK client manager directly
    const task = taskManager.getTask(taskId);
    if (!task) return false;

    const taskCwd = task.cwd || process.cwd();
    // RC-5: Heartbeat before long-running rotateOnError
    taskManager.appendOutput(taskId, `[rotation] Rotating to next account...`);
    const rotationResult = await sdkClientManager.rotateOnError(taskCwd, `status_${statusCode}`);

    // RC-2: Check terminal state after rotateOnError await
    const taskAfterRotate = taskManager.getTask(taskId);
    if (!taskAfterRotate || isTerminalStatus(taskAfterRotate.status)) {
      console.error(`[sdk-session-adapter] Task ${taskId} became ${taskAfterRotate?.status ?? 'deleted'} during rotateOnError`);
      return false;
    }

    if (!rotationResult.success) {
      if (rotationResult.allExhausted) {
        taskManager.appendOutput(taskId, `[rotation] All accounts exhausted`);
      }
      return false;
    }

    // RC-5: Heartbeat before long-running health check
    taskManager.appendOutput(taskId, `[rotation] Running health check on new account...`);
    const healthCheckPassed = await this.performHealthCheck(taskCwd);

    // RC-2: Check terminal state after health check await
    const taskAfterHealth = taskManager.getTask(taskId);
    if (!taskAfterHealth || isTerminalStatus(taskAfterHealth.status)) {
      console.error(`[sdk-session-adapter] Task ${taskId} became ${taskAfterHealth?.status ?? 'deleted'} during health check`);
      return false;
    }

    if (!healthCheckPassed) {
      binding.rotationAttempts++;
      taskManager.appendOutput(taskId, `[rotation] Health check failed, trying next account (attempt ${binding.rotationAttempts}/${binding.maxRotationAttempts})...`);
      if (binding.rotationAttempts >= binding.maxRotationAttempts) {
        return false;
      }
      // Recursively try next account
      return this.attemptRotationAndResume(taskId, binding, statusCode, errorMessage);
    }

    // Try to resume session with new account
    try {
      // RC-5: Heartbeat before long-running resumeSession
      taskManager.appendOutput(taskId, `[rotation] Health check passed, resuming session ${binding.sessionId}...`);

      const newSession = await sdkClientManager.resumeSession(taskCwd, binding.sessionId, {}, taskId);

      // RC-2: Check terminal state after resumeSession await
      const taskAfterResume = taskManager.getTask(taskId);
      if (!taskAfterResume || isTerminalStatus(taskAfterResume.status)) {
        console.error(`[sdk-session-adapter] Task ${taskId} became ${taskAfterResume?.status ?? 'deleted'} during resumeSession`);
        // Clean up the orphaned session
        await sdkClientManager.destroySession(newSession.sessionId).catch(() => {});
        return false;
      }

      await this.rebindWithNewSession(taskId, binding, newSession);
      return true;
    } catch (resumeErr) {
      console.error(`[sdk-session-adapter] Failed to resume session after rotation:`, resumeErr);
      return false;
    }
  }

  /**
   * Rebind a task with a new session after rotation
   */
  private async rebindWithNewSession(
    taskId: string,
    oldBinding: SessionBinding,
    newSession: CopilotSession
  ): Promise<void> {
    // Unsubscribe from old session
    oldBinding.unsubscribe();

    // RC-4: Verify task is still alive before rebinding
    const task = taskManager.getTask(taskId);
    if (!task || isTerminalStatus(task.status)) {
      console.error(`[sdk-session-adapter] Task ${taskId} is ${task?.status ?? 'deleted'}, skipping rebind`);
      await sdkClientManager.destroySession(newSession.sessionId).catch(() => {});
      return;
    }

    // Create new binding preserving state
    const newBinding: SessionBinding = {
      taskId,
      session: newSession,
      sessionId: newSession.sessionId,
      unsubscribe: () => {},
      outputBuffer: oldBinding.outputBuffer,
      lastMessageId: oldBinding.lastMessageId,
      startTime: oldBinding.startTime,
      isCompleted: false,
      isPaused: false,
      rotationAttempts: oldBinding.rotationAttempts,
      maxRotationAttempts: oldBinding.maxRotationAttempts,
      rotationInProgress: false,
      pendingPrompt: oldBinding.pendingPrompt,
      // Preserve metrics
      turnCount: oldBinding.turnCount,
      totalTokens: oldBinding.totalTokens,
      toolMetrics: oldBinding.toolMetrics,
      toolStartTimes: oldBinding.toolStartTimes,
      toolCallIdToName: oldBinding.toolCallIdToName,
      activeSubagents: oldBinding.activeSubagents,
      completedSubagents: oldBinding.completedSubagents,
      quotas: oldBinding.quotas,
    };

    // Subscribe to new session events
    const unsubscribe = newSession.on((event: SessionEvent) => {
      this.handleEvent(taskId, event, newBinding).catch((err) => {
        console.error(`[sdk-session-adapter] Error handling event ${event.type} for task ${taskId}:`, err);
      });
    });

    newBinding.unsubscribe = unsubscribe;
    this.bindings.set(taskId, newBinding);

    // Update task with new session reference
    taskManager.updateTask(taskId, {
      sessionId: newSession.sessionId,
      session: newSession,
    });

    taskManager.appendOutput(taskId, `[rotation] Successfully resumed with new session`);
    console.error(`[sdk-session-adapter] Rebind task ${taskId} to new session ${newSession.sessionId}`);

    // Send "continue" message to resume the conversation
    taskManager.appendOutput(taskId, `[rotation] Sending 'continue' to resume conversation...`);
    try {
      await newSession.sendAndWait({ prompt: 'continue' });
    } catch (err) {
      console.error(`[sdk-session-adapter] Failed to send continue message:`, err);
      // Don't fail the rebind - the session is still valid, just the continue failed
    }
  }

  /**
   * Mark task as rate limited (for when rotation is exhausted)
   */
  private markAsRateLimited(taskId: string, binding: SessionBinding, message: string, failureContext?: FailureContext): void {
    binding.isCompleted = true;
    binding.rateLimitInfo = { statusCode: RATE_LIMIT_STATUS_CODE };

    // Use quota reset date if available
    let nextRetryTime: string;
    const quotaInfo = Array.from(binding.quotas.values()).find(q => q.resetDate);
    if (quotaInfo?.resetDate) {
      nextRetryTime = quotaInfo.resetDate;
    } else {
      nextRetryTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    }

    const retryInfo: RetryInfo = {
      reason: message,
      retryCount: 0,
      nextRetryTime,
      maxRetries: 6,
      originalTaskId: taskId,
    };

    this.updateSessionMetrics(taskId, binding);

    taskManager.updateTask(taskId, {
      status: TaskStatus.RATE_LIMITED,
      endTime: new Date().toISOString(),
      error: message,
      retryInfo,
      failureContext,
    });

    console.error(`[sdk-session-adapter] Task ${taskId} rate limited (all rotations exhausted)`);
  }

  /**
   * Mark task as failed with structured failure context
   */
  private markAsFailed(taskId: string, binding: SessionBinding, message: string, statusCode?: number, failureContext?: FailureContext): void {
    if (!binding.isCompleted) {
      binding.isCompleted = true;
      binding.error = message;

      this.updateSessionMetrics(taskId, binding);

      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: `${message}${statusCode ? ` (status: ${statusCode})` : ''}`,
        exitCode: 1,
        failureContext,
      });

      console.error(`[sdk-session-adapter] Task ${taskId} failed: ${message}`);
    }
  }

  /**
   * Handle assistant.message_delta event (streaming)
   */
  private handleMessageDelta(
    taskId: string,
    event: AssistantMessageDeltaEvent,
    binding: SessionBinding
  ): void {
    if (event.data.deltaContent) {
      taskManager.appendOutput(taskId, event.data.deltaContent);
      binding.outputBuffer.push(event.data.deltaContent);
    }
    binding.lastMessageId = event.data.messageId;
  }

  /**
   * Handle assistant.message event (final message)
   * Also checks for string-based rate limit detection as fallback
   */
  private async handleAssistantMessage(
    taskId: string,
    event: AssistantMessageEvent,
    binding: SessionBinding
  ): Promise<void> {
    taskManager.appendOutput(taskId, `\n[assistant] Message complete: ${event.data.messageId}`);
    if (event.data.content && !binding.outputBuffer.length) {
      // Non-streaming mode - emit full content
      taskManager.appendOutput(taskId, event.data.content);
    }
    binding.lastMessageId = event.data.messageId;

    // String-based rate limit detection fallback
    // Only check current message content to avoid loops
    const content = event.data.content || '';
    if (content.includes(RATE_LIMIT_STRING) && !binding.isCompleted && !binding.isPaused && !binding.rotationInProgress) {
      // Check max rotation attempts first (parity with error-driven path at line 418)
      if (binding.rotationAttempts >= binding.maxRotationAttempts) {
        const currentTask = taskManager.getTask(taskId);
        if (!currentTask || isTerminalStatus(currentTask.status)) {
          return;
        }
        this.markAsRateLimited(taskId, binding, 'Rate limit detected in response (max rotations exhausted)');
        return;
      }
      // RC-1: Guard against concurrent rotation from string-based rate limit detection
      binding.rotationInProgress = true;
      binding.isPaused = true;
      binding.rotationAttempts++;

      taskManager.appendOutput(taskId, `[rate-limit] Detected rate limit in response, attempting rotation...`);

      let rotationSuccess = false;
      try {
        rotationSuccess = await this.attemptRotationAndResume(taskId, binding, 429, 'Rate limit detected in response');
      } finally {
        binding.rotationInProgress = false;
      }

      if (!rotationSuccess) {
        // RC-6: Re-check terminal state before marking
        const currentTask = taskManager.getTask(taskId);
        if (!currentTask || isTerminalStatus(currentTask.status)) {
          return;
        }
        this.markAsRateLimited(taskId, binding, 'Rate limit detected in response (rotation failed)');
      }
    }
  }

  /**
   * Handle assistant.usage event for quota tracking
   * Stores structured quota info and updates session metrics
   */
  private handleUsage(
    taskId: string,
    event: AssistantUsageEvent,
    binding: SessionBinding
  ): void {
    const { model, inputTokens, outputTokens, quotaSnapshots, cacheReadTokens, cacheWriteTokens, cost } = event.data;

    // Update total tokens
    binding.totalTokens.input += inputTokens || 0;
    binding.totalTokens.output += outputTokens || 0;

    taskManager.appendOutput(
      taskId,
      `[usage] Model: ${model}, Input: ${inputTokens || 0}, Output: ${outputTokens || 0}${cost ? `, Cost: $${cost.toFixed(4)}` : ''}`
    );

    // Process quota snapshots and store structured info
    if (quotaSnapshots) {
      for (const [tier, snapshotRaw] of Object.entries(quotaSnapshots)) {
        const snapshot = snapshotRaw as QuotaSnapshot;
        const quotaInfo: QuotaInfo = {
          tier,
          remainingPercentage: snapshot.remainingPercentage,
          usedRequests: snapshot.usedRequests ?? 0,
          entitlementRequests: snapshot.entitlementRequests ?? 0,
          isUnlimited: snapshot.isUnlimitedEntitlement ?? false,
          overage: snapshot.overage ?? 0,
          resetDate: snapshot.resetDate,
          lastUpdated: new Date().toISOString(),
        };

        binding.quotas.set(tier, quotaInfo);
        
        if (snapshot.remainingPercentage <= 10) {
          taskManager.appendOutput(
            taskId,
            `[quota] Warning: ${tier} at ${snapshot.remainingPercentage}% remaining (resets: ${snapshot.resetDate || 'unknown'})`
          );

          // Update task with quota warning
          taskManager.updateTask(taskId, { quotaInfo });

          binding.rateLimitInfo = {
            statusCode: 0, // Not yet rate limited
            remainingPercentage: snapshot.remainingPercentage,
            resetDate: snapshot.resetDate,
          };

          // Proactively rotate if quota is critically low (< 1%)
          // Guard: Only rotate if not already rotating (prevents race condition)
          if (snapshot.remainingPercentage < 1 &&
              binding.rotationAttempts < binding.maxRotationAttempts &&
              !binding.rotationInProgress) {
            binding.rotationInProgress = true;
            binding.isPaused = true;
            binding.rotationAttempts++;  // Count proactive rotation toward the limit
            taskManager.appendOutput(taskId, `[quota] Quota critically low, proactively rotating (attempt ${binding.rotationAttempts}/${binding.maxRotationAttempts})...`);
            this.attemptRotationAndResume(taskId, binding, 429, 'Quota critically low')
              .finally(() => {
                binding.rotationInProgress = false;
                binding.isPaused = false;
              })
              .catch(console.error);
          }
        }
      }
    }

    // Update session metrics
    this.updateSessionMetrics(taskId, binding);
  }

  /**
   * Handle tool.execution_start event - track tool metrics
   */
  private handleToolStart(taskId: string, event: ToolExecutionStartEvent, binding: SessionBinding): void {
    const { toolName, toolCallId, mcpServerName, mcpToolName } = event.data;
    
    // Track start time and toolCallId → toolName mapping for accurate completion matching (METRIC-1 fix)
    binding.toolStartTimes.set(toolCallId, Date.now());
    binding.toolCallIdToName.set(toolCallId, toolName);

    // Initialize or update tool metrics
    let metrics = binding.toolMetrics.get(toolName);
    if (!metrics) {
      metrics = {
        toolName,
        mcpServer: mcpServerName,
        mcpToolName,
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
      };
      binding.toolMetrics.set(toolName, metrics);
    }

    const serverInfo = mcpServerName ? ` (MCP: ${mcpServerName})` : '';
    taskManager.appendOutput(taskId, `[tool] Starting: ${toolName}${serverInfo}`);
  }

  /**
   * Handle tool.execution_complete event - finalize tool metrics
   */
  private handleToolComplete(taskId: string, event: ToolExecutionCompleteEvent, binding: SessionBinding): void {
    const { toolCallId, success } = event.data;

    // METRIC-1 fix: Use toolCallId → toolName mapping for accurate completion matching
    const startTime = binding.toolStartTimes.get(toolCallId);
    const duration = startTime ? Date.now() - startTime : 0;
    const toolName = binding.toolCallIdToName.get(toolCallId);
    
    // Clean up tracking maps
    binding.toolStartTimes.delete(toolCallId);
    binding.toolCallIdToName.delete(toolCallId);

    // Find and update metrics using the tracked toolName (deterministic matching)
    const metrics = toolName ? binding.toolMetrics.get(toolName) : undefined;
    if (metrics) {
      metrics.executionCount++;
      metrics.totalDurationMs += duration;
      metrics.lastExecutedAt = new Date().toISOString();
      
      if (success) {
        metrics.successCount++;
        taskManager.appendOutput(taskId, `[tool] Completed: ${metrics.toolName} (${duration}ms)`);
      } else {
        metrics.failureCount++;
        const errorMsg = event.data.error?.message || 'Unknown error';
        taskManager.appendOutput(taskId, `[tool] Failed: ${metrics.toolName} - ${errorMsg}`);
      }
    } else {
      // Fallback: log completion without metrics update if toolName not found
      taskManager.appendOutput(taskId, `[tool] Completed: unknown (${duration}ms, callId: ${toolCallId})`);
    }

    this.updateSessionMetrics(taskId, binding);
  }

  /**
   * Handle subagent.started event
   */
  private handleSubagentStarted(taskId: string, event: SubagentStartedEvent, binding: SessionBinding): void {
    const { agentName, agentDisplayName, agentDescription, toolCallId } = event.data;

    const subagentInfo: SubagentInfo = {
      agentName,
      agentDisplayName,
      agentDescription,
      toolCallId,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    binding.activeSubagents.set(toolCallId, subagentInfo);
    taskManager.appendOutput(taskId, `[subagent] Started: ${agentDisplayName}`);
    this.updateSessionMetrics(taskId, binding);
  }

  /**
   * Handle subagent.completed event
   */
  private handleSubagentCompleted(taskId: string, event: SubagentCompletedEvent, binding: SessionBinding): void {
    const { agentName, toolCallId } = event.data;
    
    const subagent = binding.activeSubagents.get(toolCallId);
    if (subagent) {
      subagent.status = 'completed';
      subagent.endedAt = new Date().toISOString();
      binding.completedSubagents.push(subagent);
      binding.activeSubagents.delete(toolCallId);
    }

    taskManager.appendOutput(taskId, `[subagent] Completed: ${agentName}`);
    this.updateSessionMetrics(taskId, binding);
  }

  /**
   * Handle subagent.failed event
   */
  private handleSubagentFailed(taskId: string, event: SubagentFailedEvent, binding: SessionBinding): void {
    const { agentName, toolCallId, error } = event.data;
    
    const subagent = binding.activeSubagents.get(toolCallId);
    if (subagent) {
      subagent.status = 'failed';
      subagent.error = error;
      subagent.endedAt = new Date().toISOString();
      binding.completedSubagents.push(subagent);
      binding.activeSubagents.delete(toolCallId);
    }

    taskManager.appendOutput(taskId, `[subagent] Failed: ${agentName} - ${error}`);
    this.updateSessionMetrics(taskId, binding);
  }

  /**
   * Handle session.shutdown event - extract completion metrics
   */
  private handleSessionShutdown(
    taskId: string,
    event: SessionShutdownEvent,
    binding: SessionBinding
  ): void {
    taskManager.appendOutput(taskId, `[session] Shutdown: ${event.data.shutdownType}`);

    // Extract completion metrics from shutdown event
    const completionMetrics: CompletionMetrics = {
      totalApiCalls: event.data.totalPremiumRequests || 0,
      totalApiDurationMs: event.data.totalApiDurationMs || 0,
      codeChanges: {
        linesAdded: event.data.codeChanges?.linesAdded || 0,
        linesRemoved: event.data.codeChanges?.linesRemoved || 0,
        filesModified: event.data.codeChanges?.filesModified || [],
      },
      modelUsage: {},
      sessionStartTime: binding.startTime.getTime(),
      currentModel: event.data.modelMetrics ? Object.keys(event.data.modelMetrics)[0] : undefined,
    };

    // Process model metrics if available
    if (event.data.modelMetrics) {
      for (const [model, metricsRaw] of Object.entries(event.data.modelMetrics)) {
        const metrics = metricsRaw as unknown as ModelMetricsData;
        completionMetrics.modelUsage[model] = {
          requests: metrics.requests || 0,
          cost: metrics.cost || 0,
          tokens: {
            input: metrics.inputTokens || 0,
            output: metrics.outputTokens || 0,
            cacheRead: metrics.cacheReadTokens || 0,
            cacheWrite: metrics.cacheWriteTokens || 0,
          },
        };
      }
    }

    // Log completion metrics summary
    if (completionMetrics.totalApiCalls > 0) {
      taskManager.appendOutput(
        taskId,
        `[metrics] API calls: ${completionMetrics.totalApiCalls}, Duration: ${completionMetrics.totalApiDurationMs}ms`
      );
    }
    if (completionMetrics.codeChanges.linesAdded > 0 || completionMetrics.codeChanges.linesRemoved > 0) {
      taskManager.appendOutput(
        taskId,
        `[metrics] Code: +${completionMetrics.codeChanges.linesAdded}/-${completionMetrics.codeChanges.linesRemoved} lines, ${completionMetrics.codeChanges.filesModified.length} files`
      );
    }

    // Update session metrics and completion metrics
    this.updateSessionMetrics(taskId, binding);
    taskManager.updateTask(taskId, { completionMetrics });
    
    if (event.data.shutdownType === 'error' && !binding.isCompleted) {
      binding.isCompleted = true;
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: new Date().toISOString(),
        error: event.data.errorReason || 'Session shutdown with error',
        exitCode: 1,
      });
    }
  }

  /**
   * Handle abort event
   */
  private handleAbort(
    taskId: string,
    event: Extract<SessionEvent, { type: 'abort' }>,
    binding: SessionBinding
  ): void {
    taskManager.appendOutput(taskId, `[session] Aborted: ${event.data.reason}`);
    
    if (!binding.isCompleted) {
      binding.isCompleted = true;
      this.updateSessionMetrics(taskId, binding);
      taskManager.updateTask(taskId, {
        status: TaskStatus.CANCELLED,
        endTime: new Date().toISOString(),
      });
    }
  }

  /**
   * Update session metrics in task state
   * Uses SDK's UsageMetricsTracker for token/request metrics, combined with our custom tracking
   */
  private updateSessionMetrics(taskId: string, binding: SessionBinding): void {
    const toolMetricsObj: Record<string, ToolMetrics> = {};
    for (const [name, metrics] of binding.toolMetrics) {
      toolMetricsObj[name] = metrics;
    }

    const quotasObj: Record<string, QuotaInfo> = {};
    for (const [tier, quota] of binding.quotas) {
      quotasObj[tier] = quota;
    }

    const sessionMetrics: SessionMetrics = {
      quotas: quotasObj,
      toolMetrics: toolMetricsObj,
      activeSubagents: Array.from(binding.activeSubagents.values()),
      completedSubagents: binding.completedSubagents,
      turnCount: binding.turnCount,
      totalTokens: {
        input: binding.totalTokens.input,
        output: binding.totalTokens.output,
      },
    };

    taskManager.updateTask(taskId, { sessionMetrics });
  }

  /**
   * Unbind a session from a task.
   */
  unbind(taskId: string): void {
    const binding = this.bindings.get(taskId);
    if (binding) {
      binding.unsubscribe();
      this.bindings.delete(taskId);
      clearTaskToolMetrics(taskId);
      console.error(`[sdk-session-adapter] Unbound session from task ${taskId}`);
    }
  }

  /**
   * Get the binding for a task.
   */
  getBinding(taskId: string): SessionBinding | undefined {
    return this.bindings.get(taskId);
  }

  /**
   * Get the session for a task.
   */
  getSession(taskId: string): CopilotSession | undefined {
    return this.bindings.get(taskId)?.session;
  }

  /**
   * Check if a task has an active session.
   */
  hasSession(taskId: string): boolean {
    return this.bindings.has(taskId);
  }

  /**
   * Get accumulated output for a task.
   */
  getOutput(taskId: string): string[] {
    return this.bindings.get(taskId)?.outputBuffer || [];
  }

  /**
   * Mark a task as timed out.
   */
  markTimedOut(taskId: string, timeoutMs: number): void {
    const binding = this.bindings.get(taskId);
    if (binding && !binding.isCompleted) {
      binding.isCompleted = true;

      this.updateSessionMetrics(taskId, binding);

      taskManager.updateTask(taskId, {
        status: TaskStatus.TIMED_OUT,
        endTime: new Date().toISOString(),
        error: `Task timed out after ${timeoutMs}ms`,
        timeoutReason: 'hard_timeout',
        timeoutContext: {
          timeoutMs,
          detectedBy: 'sdk_adapter',
        },
      });

      // Abort the session
      binding.session.abort().catch((err: unknown) => {
        console.error(`[sdk-session-adapter] Failed to abort timed-out session ${taskId}:`, err);
      });
    }
  }

  /**
   * Cleanup all bindings.
   */
  cleanup(): void {
    for (const [taskId, binding] of this.bindings) {
      binding.unsubscribe();
      clearTaskToolMetrics(taskId);
    }
    this.bindings.clear();
  }

  /**
   * Get statistics.
   */
  getStats(): { 
    activeBindings: number; 
    totalRotations: number;
    totalTurns: number;
    totalTokens: { input: number; output: number };
  } {
    let totalRotations = 0;
    let totalTurns = 0;
    const totalTokens = { input: 0, output: 0 };

    for (const binding of this.bindings.values()) {
      totalRotations += binding.rotationAttempts;
      totalTurns += binding.turnCount;
      totalTokens.input += binding.totalTokens.input;
      totalTokens.output += binding.totalTokens.output;
    }

    return {
      activeBindings: this.bindings.size,
      totalRotations,
      totalTurns,
      totalTokens,
    };
  }
}

export const sdkSessionAdapter = new SDKSessionAdapter();
