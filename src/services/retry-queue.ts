import { TaskState, TaskStatus, RetryInfo } from '../types.js';

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
 * Check if an error/output indicates rate limiting
 */
export function isRateLimitError(output: string[], error?: string): boolean {
  const allText = [...output, error || ''].join('\n');
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(allText));
}

/**
 * Extract rate limit wait time from error message if present
 * Returns milliseconds or null if not found
 */
export function extractWaitTime(output: string[], error?: string): number | null {
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
 * Calculate next retry time based on retry count
 */
export function calculateNextRetryTime(retryCount: number, suggestedWaitMs?: number | null): string {
  let delayMs: number;
  
  if (suggestedWaitMs && suggestedWaitMs > 0) {
    // Use suggested wait time from error message, but add some jitter
    delayMs = suggestedWaitMs + Math.random() * 60000; // +0-60s jitter
  } else {
    // Use exponential backoff
    const index = Math.min(retryCount, DEFAULT_RETRY_DELAYS_MS.length - 1);
    delayMs = DEFAULT_RETRY_DELAYS_MS[index];
  }
  
  const nextRetryTime = new Date(Date.now() + delayMs);
  return nextRetryTime.toISOString();
}

/**
 * Create retry info for a rate-limited task
 */
export function createRetryInfo(
  task: TaskState,
  reason: string,
  existingRetryInfo?: RetryInfo
): RetryInfo {
  const retryCount = (existingRetryInfo?.retryCount ?? 0) + 1;
  const suggestedWait = extractWaitTime(task.output, task.error);
  
  return {
    reason,
    retryCount,
    nextRetryTime: calculateNextRetryTime(retryCount - 1, suggestedWait),
    maxRetries: MAX_RETRIES,
    originalTaskId: existingRetryInfo?.originalTaskId || task.id,
  };
}

/**
 * Check if a task should be retried now
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
  
  const nextRetryTime = new Date(task.retryInfo.nextRetryTime).getTime();
  return Date.now() >= nextRetryTime;
}

/**
 * Check if a task has exceeded max retries
 */
export function hasExceededMaxRetries(task: TaskState): boolean {
  if (!task.retryInfo) {
    return false;
  }
  return task.retryInfo.retryCount >= task.retryInfo.maxRetries;
}

/**
 * Get all rate-limited tasks that are ready for retry
 */
export function getTasksReadyForRetry(tasks: TaskState[]): TaskState[] {
  return tasks.filter(shouldRetryNow);
}

/**
 * Format retry status for display
 */
export function formatRetryStatus(task: TaskState): string {
  if (!task.retryInfo) {
    return 'No retry info';
  }
  
  const { retryCount, maxRetries, nextRetryTime, reason } = task.retryInfo;
  const nextRetry = new Date(nextRetryTime);
  const now = new Date();
  const diffMs = nextRetry.getTime() - now.getTime();
  
  if (diffMs <= 0) {
    return `Ready for retry (attempt ${retryCount + 1}/${maxRetries})`;
  }
  
  const diffMinutes = Math.ceil(diffMs / 60000);
  return `Retry in ${diffMinutes} min (attempt ${retryCount}/${maxRetries}) - ${reason}`;
}
