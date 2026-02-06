import type { CopilotSession } from '@github/copilot-sdk';
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';

export type Provider = 'copilot' | 'claude-cli';

export enum TaskStatus {
  PENDING = 'pending',
  WAITING = 'waiting',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  RATE_LIMITED = 'rate_limited',
  TIMED_OUT = 'timed_out',
}

export type TimeoutReason =
  | 'hard_timeout'
  | 'stall'
  | 'session_error'
  | 'server_restart'
  | 'unknown';

export interface TimeoutContext {
  timeoutMs?: number;
  timeoutAt?: string;
  elapsedMs?: number;
  lastOutputAt?: string;
  lastOutputAgeMs?: number;
  lastHeartbeatAt?: string;
  sessionAlive?: boolean;
  detectedBy?: 'sdk_adapter' | 'health_check' | 'startup_recovery' | 'manual';
}

export interface RetryInfo {
  reason: string;
  retryCount: number;
  nextRetryTime: string;
  maxRetries: number;
  originalTaskId?: string;
}

// ============================================================================
// SDK Abstraction Enhancement Types
// ============================================================================

/**
 * Structured failure context from SDK session.error events.
 * Replaces string parsing with native SDK error classification.
 */
export interface FailureContext {
  /** SDK's error classification (e.g., "rate_limit", "model_error", "timeout") */
  errorType: string;
  /** HTTP status code when available (e.g., 429, 500) */
  statusCode?: number;
  /** Error context category from SDK hooks */
  errorContext?: 'model_call' | 'tool_execution' | 'system' | 'user_input';
  /** Provider call ID for debugging specific API calls */
  providerCallId?: string;
  /** Whether the error is recoverable (from SDK hook) */
  recoverable?: boolean;
  /** Original error message */
  message: string;
  /** Stack trace if available */
  stack?: string;
}

/**
 * Completion metrics from SDK session.shutdown events.
 * Provides rich telemetry about completed sessions.
 */
export interface CompletionMetrics {
  /** Total premium API requests made */
  totalApiCalls: number;
  /** Total API duration in milliseconds */
  totalApiDurationMs: number;
  /** Code changes made during the session */
  codeChanges: {
    linesAdded: number;
    linesRemoved: number;
    filesModified: string[];
  };
  /** Per-model usage breakdown */
  modelUsage: Record<string, {
    requests: number;
    cost: number;
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
  }>;
  /** Session start time (unix timestamp) */
  sessionStartTime: number;
  /** Current/final model used */
  currentModel?: string;
}

/**
 * Quota information from SDK assistant.usage.quotaSnapshots.
 * Enables proactive rate limit management.
 */
export interface QuotaInfo {
  /** Quota tier (e.g., "premium", "standard") */
  tier: string;
  /** Remaining percentage of quota (0-100) */
  remainingPercentage: number;
  /** Used requests in current period */
  usedRequests: number;
  /** Total entitlement requests */
  entitlementRequests: number;
  /** Whether quota is unlimited */
  isUnlimited: boolean;
  /** Overage amount if over quota */
  overage: number;
  /** ISO timestamp when quota resets */
  resetDate?: string;
  /** Last updated timestamp */
  lastUpdated: string;
}

/**
 * Tool execution metrics from SDK tool.* events.
 * Enables tool performance monitoring.
 */
export interface ToolMetrics {
  /** Tool name */
  toolName: string;
  /** MCP server name if external tool */
  mcpServer?: string;
  /** MCP tool name if different from toolName */
  mcpToolName?: string;
  /** Total execution count */
  executionCount: number;
  /** Successful executions */
  successCount: number;
  /** Failed executions */
  failureCount: number;
  /** Total execution time in ms */
  totalDurationMs: number;
  /** Last execution timestamp */
  lastExecutedAt?: string;
}

/**
 * Subagent tracking from SDK subagent.* events.
 */
export interface SubagentInfo {
  /** Subagent name */
  agentName: string;
  /** Display name */
  agentDisplayName: string;
  /** Description */
  agentDescription?: string;
  /** Tool call ID that spawned this subagent */
  toolCallId: string;
  /** Status */
  status: 'running' | 'completed' | 'failed';
  /** Error if failed */
  error?: string;
  /** Tools available to subagent */
  tools?: string[];
  /** Start timestamp */
  startedAt: string;
  /** End timestamp */
  endedAt?: string;
}

/**
 * Aggregated session metrics for observability.
 */
export interface SessionMetrics {
  /** Quota information per tier */
  quotas: Record<string, QuotaInfo>;
  /** Tool execution metrics */
  toolMetrics: Record<string, ToolMetrics>;
  /** Active subagents */
  activeSubagents: SubagentInfo[];
  /** Completed subagents */
  completedSubagents: SubagentInfo[];
  /** Turn count */
  turnCount: number;
  /** Total tokens used */
  totalTokens: {
    input: number;
    output: number;
  };
  /** SDK's native aggregated metrics from UsageMetricsTracker */
  sdkMetrics?: {
    totalPremiumRequests: number;
    totalApiDurationMs: number;
    codeChanges?: {
      linesAdded: number;
      linesRemoved: number;
      filesModified: number;
    };
  };
}

// ============================================================================
// User Input / Question Types (SDK ask_user tool support)
// ============================================================================

/**
 * Pending question from SDK's ask_user tool.
 * Task is paused waiting for user response.
 */
export interface PendingQuestion {
  /** The question being asked */
  question: string;
  /** Optional predefined choices (1-indexed for user display) */
  choices?: string[];
  /** Whether freeform text input is allowed beyond choices */
  allowFreeform: boolean;
  /** ISO timestamp when question was asked */
  askedAt: string;
  /** Session ID that asked the question */
  sessionId: string;
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  prompt: string;
  output: string[];
  sessionId?: string;
  session?: CopilotSession;
  startTime: string;
  lastOutputAt?: string;
  lastHeartbeatAt?: string;
  endTime?: string;
  exitCode?: number;
  error?: string;
  cwd?: string;
  model?: string;
  autonomous?: boolean;
  isResume?: boolean;
  retryInfo?: RetryInfo;
  dependsOn?: string[];
  timeout?: number;
  timeoutAt?: string;
  timeoutReason?: TimeoutReason;
  timeoutContext?: TimeoutContext;
  labels?: string[];
  provider?: Provider;
  fallbackAttempted?: boolean;
  switchAttempted?: boolean;
  // SDK Enhancement Fields
  /** Structured failure context from SDK events */
  failureContext?: FailureContext;
  /** Completion metrics from session.shutdown */
  completionMetrics?: CompletionMetrics;
  /** Current quota information */
  quotaInfo?: QuotaInfo;
  /** Session-level metrics */
  sessionMetrics?: SessionMetrics;
  /** Pending question from SDK ask_user tool - task is paused */
  pendingQuestion?: PendingQuestion;
  /** Path to live output file for agent monitoring */
  outputFilePath?: string;
}

export interface SpawnOptions {
  prompt: string;
  timeout?: number;
  cwd?: string;
  model?: string;
  taskType?: string;
  autonomous?: boolean;
  resumeSessionId?: string;
  retryInfo?: RetryInfo;
  dependsOn?: string[];
  labels?: string[];
  provider?: Provider;
  fallbackAttempted?: boolean;
  switchAttempted?: boolean;
}

export interface ToolContext {
  progressToken?: string | number;
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

// ============================================================================
// Terminal Status Utilities (canonical location — import from here)
// ============================================================================

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.TIMED_OUT,
]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ============================================================================
// Error Classification Constants (canonical location — import from here)
// ============================================================================

export const ROTATABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const RATE_LIMIT_STATUS_CODE = 429;
