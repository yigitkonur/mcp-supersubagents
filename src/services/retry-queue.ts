import { TaskState, TaskStatus, RetryInfo } from '../types.js';

// Legacy patterns kept for backward compatibility with non-SDK errors
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /try again in \d+ (hour|minute|second)/i,
  /exceeded.*quota/i,
  /throttl/i,
];

const DEFAULT_RETRY_DELAYS_MS = [
  5 * 60 * 1000,    // 5 minutes
  10 * 60 * 1000,   // 10 minutes
  20 * 60 * 1000,   // 20 minutes
  40 * 60 * 1000,   // 40 minutes
  60 * 60 * 1000,   // 1 hour
  120 * 60 * 1000,  // 2 hours (max)
];

const MAX_RETRIES = DEFAULT_RETRY_DELAYS_MS.length;

/**
 * Check if an error/output indicates rate limiting.
 * Now prefers SDK structured data over string parsing.
 */
export function isRateLimitError(output: string[], error?: string, task?: TaskState): boolean {
  // Prefer SDK structured failure context
  if (task?.failureContext?.statusCode === 429) {
    return true;
  }
  
  // Check quota info for exhausted quota
  if (task?.quotaInfo?.remainingPercentage !== undefined && task.quotaInfo.remainingPercentage < 1) {
    return true;
  }

  // Fallback to string pattern matching for non-SDK errors
  const allText = [...output, error || ''].join('\n');
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(allText));
}

/**
 * Extract rate limit wait time from error message if present.
 * Returns milliseconds or null if not found.
 * Now prefers SDK quotaInfo.resetDate for precise timing.
 */
export function extractWaitTime(output: string[], error?: string, task?: TaskState): number | null {
  // Prefer SDK quota reset date for precise timing
  if (task?.quotaInfo?.resetDate) {
    const resetTime = new Date(task.quotaInfo.resetDate).getTime();
    const now = Date.now();
    if (resetTime > now) {
      return resetTime - now;
    }
  }

  // Fallback to string parsing
  const allText = [...output, error || ''].join('\n');
  
  // Match patterns like "try again in 2 hours" or "wait 30 minutes"
  const hourMatch = allText.match(/(?:try again|wait).*?(\d+)\s*hour/i);
  if (hourMatch) {
    return parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
  }
  
  const minuteMatch = allText.match(/(?:try again|wait).*?(\d+)\s*minute/i);
  if (minuteMatch) {
    return parseInt(minuteMatch[1], 10) * 60 * 1000;
  }
  
  const secondMatch = allText.match(/(?:try again|wait).*?(\d+)\s*second/i);
  if (secondMatch) {
    return parseInt(secondMatch[1], 10) * 1000;
  }
  
  return null;
}

/**
 * Calculate next retry time based on retry count and SDK data.
 * Uses quotaInfo.resetDate when available for precise timing.
 */
export function calculateNextRetryTime(
  retryCount: number, 
  suggestedWaitMs?: number | null,
  task?: TaskState
): string {
  let delayMs: number;

  // Priority 1: Use SDK quota reset date if available and in the future
  if (task?.quotaInfo?.resetDate) {
    const resetTime = new Date(task.quotaInfo.resetDate).getTime();
    const now = Date.now();
    if (resetTime > now) {
      // Add a small buffer (30s) after reset
      return new Date(resetTime + 30000).toISOString();
    }
  }
  
  // Priority 2: Use suggested wait time from error message
  if (suggestedWaitMs && suggestedWaitMs > 0) {
    // Add some jitter to avoid thundering herd
    delayMs = suggestedWaitMs + Math.random() * 60000; // +0-60s jitter
  } else {
    // Priority 3: Use exponential backoff
    const index = Math.min(retryCount, DEFAULT_RETRY_DELAYS_MS.length - 1);
    delayMs = DEFAULT_RETRY_DELAYS_MS[index] + Math.floor(Math.random() * 60000); // +0-60s jitter to prevent thundering herd
  }
  
  const nextRetryTime = new Date(Date.now() + delayMs);
  return nextRetryTime.toISOString();
}

/**
 * Create retry info for a rate-limited task.
 * Now uses SDK structured data for better timing.
 */
export function createRetryInfo(
  task: TaskState,
  reason: string,
  existingRetryInfo?: RetryInfo
): RetryInfo {
  const retryCount = (existingRetryInfo?.retryCount ?? 0) + 1;
  const suggestedWait = extractWaitTime(task.output, task.error, task);
  
  // Use SDK failure context for better reason if available
  let enhancedReason = reason;
  if (task.failureContext) {
    const { errorType, statusCode, errorContext } = task.failureContext;
    const parts: string[] = [];
    if (statusCode) parts.push(`status: ${statusCode}`);
    if (errorType) parts.push(`type: ${errorType}`);
    if (errorContext) parts.push(`context: ${errorContext}`);
    if (parts.length > 0) {
      enhancedReason = `${reason} (${parts.join(', ')})`;
    }
  }
  
  return {
    reason: enhancedReason,
    retryCount,
    nextRetryTime: calculateNextRetryTime(retryCount - 1, suggestedWait, task),
    maxRetries: MAX_RETRIES,
    originalTaskId: existingRetryInfo?.originalTaskId || task.id,
  };
}

/**
 * Check if a task should be retried now.
 * Enhanced to consider SDK quota info.
 */
export function shouldRetryNow(task: TaskState): boolean {
  if (task.status !== TaskStatus.RATE_LIMITED) {
    return false;
  }
  
  if (!task.retryInfo) {
    return true; // No retry info, retry immediately
  }
  
  if (task.retryInfo.retryCount >= task.retryInfo.maxRetries) {
    return false; // Max retries exceeded
  }

  // Check SDK quota reset date if available
  if (task.quotaInfo?.resetDate) {
    const resetTime = new Date(task.quotaInfo.resetDate).getTime();
    if (Date.now() < resetTime) {
      return false; // Quota hasn't reset yet
    }
  }
  
  const nextRetryTime = new Date(task.retryInfo.nextRetryTime).getTime();
  return Date.now() >= nextRetryTime;
}

/**
 * Check if a task has exceeded max retries.
 */
export function hasExceededMaxRetries(task: TaskState): boolean {
  if (!task.retryInfo) {
    return false;
  }
  return task.retryInfo.retryCount >= task.retryInfo.maxRetries;
}

/**
 * Check if handoff is recommended instead of retry.
 * Uses SDK data to make intelligent recommendations.
 */
export function shouldRecommendHandoff(task: TaskState): boolean {
  // If max retries exceeded and we have multiple accounts, recommend handoff
  if (hasExceededMaxRetries(task)) {
    return true;
  }

  // If quota is critically low (<1%), recommend handoff
  if (task.quotaInfo?.remainingPercentage !== undefined && task.quotaInfo.remainingPercentage < 1) {
    return true;
  }

  // If failure context indicates unrecoverable rate limit, recommend handoff
  if (task.failureContext?.statusCode === 429 && task.failureContext.recoverable === false) {
    return true;
  }

  return false;
}

/**
 * Get recommended action for a rate-limited task.
 */
export function getRecommendedAction(task: TaskState): 'retry' | 'handoff' | 'wait' | 'give_up' {
  if (task.status !== TaskStatus.RATE_LIMITED) {
    return 'give_up';
  }

  if (hasExceededMaxRetries(task)) {
    return shouldRecommendHandoff(task) ? 'handoff' : 'give_up';
  }

  if (shouldRetryNow(task)) {
    return 'retry';
  }

  if (shouldRecommendHandoff(task)) {
    return 'handoff';
  }

  return 'wait';
}
