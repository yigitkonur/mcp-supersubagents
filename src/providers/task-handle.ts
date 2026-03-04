/**
 * TaskHandle — Provider-Facing API
 *
 * A narrow interface that gives providers everything they need to
 * manage task lifecycle without importing taskManager, processRegistry,
 * TaskStatus, or isTerminalStatus directly.
 *
 * This decouples provider adapters from internal service singletons,
 * making providers true "Lego blocks" — implement one method, mount/unmount.
 */

import type { AgentMode, Provider, SubagentInfo, QuotaInfo, ToolMetrics } from '../types.js';

// ---------------------------------------------------------------------------
// Session Metrics (reported by providers on completion)
// ---------------------------------------------------------------------------

export interface SessionMetrics {
  turnCount?: number;
  totalTokens?: { input: number; output: number };
  toolMetrics?: Record<string, ToolMetrics>;
  activeSubagents?: SubagentInfo[] | string[];
  completedSubagents?: SubagentInfo[] | string[];
  quotas?: Record<string, QuotaInfo>;
}

// ---------------------------------------------------------------------------
// TaskHandle Interface
// ---------------------------------------------------------------------------

export interface TaskHandle {
  /** The task ID this handle is bound to */
  readonly taskId: string;

  // --- State transitions ---

  /** Transition to RUNNING. Optionally set the provider's session ID. */
  markRunning(sessionId?: string): void;

  /** Transition to COMPLETED with optional metrics. */
  markCompleted(metrics?: SessionMetrics): void;

  /** Transition to FAILED with an error message and optional exit code. */
  markFailed(error: string, exitCode?: number): void;

  /** Transition to CANCELLED with a reason. */
  markCancelled(reason: string): void;

  // --- Output ---

  /** Append a line to the task output buffer (shown to MCP clients). */
  writeOutput(line: string): void;

  /** Append a line to output file only (excluded from in-memory MCP output buffer). */
  writeOutputFileOnly(line: string): void;

  /**
   * Append a system-prefixed output line: `[prefix] message`.
   * Convenience wrapper over writeOutput for structured logging.
   */
  writeSystemOutput(prefix: string, message: string): void;

  // --- Lifecycle ---

  /** Register an AbortController with processRegistry for kill escalation. */
  registerAbort(controller: AbortController): void;

  /** Unregister from processRegistry (call in finally blocks). */
  unregisterAbort(): void;

  /** Check if the task has reached a terminal state (COMPLETED/FAILED/CANCELLED/TIMED_OUT). */
  isTerminal(): boolean;

  /**
   * Check if the task is still alive (exists AND not terminal).
   * Convenience inverse of isTerminal(). Use after every await in providers.
   */
  isAlive(): boolean;

  /**
   * Register a callback invoked when the task's abort signal fires.
   * Returns an unsubscribe function.
   */
  onAborted(callback: () => void): () => void;

  // --- Provider state ---

  /** Set opaque per-provider state on the task (non-serializable). */
  setProviderState(state: Record<string, unknown> | undefined): void;

  /** Set the session ID on the task (e.g., Copilot session ID, Codex thread ID). */
  setSessionId(id: string): void;

  /** Set the provider identifier on the task. */
  setProvider(provider: Provider): void;

  // --- Read-only accessors ---

  /** Get the task prompt. */
  getPrompt(): string;

  /** Get the task working directory. */
  getCwd(): string;

  /** Get the task timeout in ms. */
  getTimeout(): number;

  /** Get the task model. */
  getModel(): string;

  /** Get the task execution mode. */
  getMode(): AgentMode;
}
