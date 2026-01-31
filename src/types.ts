import type { ResultPromise } from 'execa';

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

export interface RetryInfo {
  reason: string;
  retryCount: number;
  nextRetryTime: string;
  maxRetries: number;
  originalTaskId?: string;
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  prompt: string;
  output: string[];
  pid?: number;
  sessionId?: string;
  startTime: string;
  endTime?: string;
  exitCode?: number;
  error?: string;
  cwd?: string;
  model?: string;
  autonomous?: boolean;
  isResume?: boolean;
  process?: ResultPromise;
  retryInfo?: RetryInfo;
  dependsOn?: string[];
  timeout?: number;
  timeoutAt?: string;
  labels?: string[];
  provider?: Provider;
  fallbackAttempted?: boolean;
  switchAttempted?: boolean;
}

export interface SpawnOptions {
  prompt: string;
  timeout?: number;
  cwd?: string;
  model?: string;
  autonomous?: boolean;
  resumeSessionId?: string;
  retryInfo?: RetryInfo;
  dependsOn?: string[];
  labels?: string[];
  provider?: Provider;
  fallbackAttempted?: boolean;
  switchAttempted?: boolean;
}
