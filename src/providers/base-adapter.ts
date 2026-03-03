/**
 * BaseProviderAdapter — Template Method pattern for provider adapters.
 *
 * Handles common boilerplate that every adapter duplicates:
 * - TaskHandle creation (if not provided by caller)
 * - AbortController creation + registration with handle/processRegistry
 * - Timeout timer with .unref()
 * - Mode suffix prompt assembly
 * - try/catch/finally with error classification and cleanup
 *
 * Subclasses implement only executeSession() — the provider-specific logic.
 * State transitions (markRunning, markCompleted, markFailed) are the
 * subclass's responsibility inside executeSession(), since some runners
 * manage their own transitions.
 *
 * Hooks:
 * - onSpawnStarted(taskId, abortController) — track controllers for abort()
 * - onSpawnFinished(taskId) — cleanup controller tracking
 */

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
} from './types.js';
import type { TaskHandle } from './task-handle.js';

export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;

  abstract checkAvailability(): AvailabilityResult;
  abstract getCapabilities(): ProviderCapabilities;
  abstract getStats(): Record<string, unknown>;

  /**
   * The ONLY method provider implementors write.
   *
   * Called with:
   * - handle: fully initialized TaskHandle (never null)
   * - prompt: final prompt with mode suffix already appended
   * - signal: AbortSignal tied to the abort controller (use for cancellation)
   * - options: original spawn options (taskId, cwd, model, etc.)
   *
   * The base class guarantees:
   * - handle.isTerminal() was checked before entry
   * - handle.registerAbort() was called
   * - Timeout timer is running
   * - Errors thrown here are caught by the base class and map to markFailed/markCancelled
   *
   * The subclass is responsible for:
   * - handle.markRunning() (with sessionId if applicable)
   * - handle.setProvider()
   * - Streaming/execution logic
   * - handle.markCompleted(metrics) on success
   */
  protected abstract executeSession(
    handle: TaskHandle,
    prompt: string,
    signal: AbortSignal,
    options: ProviderSpawnOptions,
  ): Promise<void>;

  /**
   * Default spawn implementation with abort/timeout/cleanup boilerplate.
   * Subclasses should NOT override this unless they have fundamentally
   * different lifecycle needs (e.g., Copilot session resume).
   */
  async spawn(options: ProviderSpawnOptions, handle?: TaskHandle): Promise<void> {
    const { taskId, timeout } = options;

    // Create handle if not provided (backward compat)
    if (!handle) {
      const { createTaskHandle } = await import('./task-handle-impl.js');
      handle = createTaskHandle(taskId);
    }

    if (handle.isTerminal()) {
      console.error(`[${this.id}] Task ${taskId} already terminal, skipping spawn`);
      return;
    }

    // Abort controller — shared between timeout timer and subclass via signal
    const abortController = new AbortController();
    handle.registerAbort(abortController);
    this.onSpawnStarted(taskId, abortController);

    // Timeout timer
    const timeoutTimer = setTimeout(() => {
      console.error(`[${this.id}] Task ${taskId} timed out after ${timeout}ms`);
      abortController.abort();
    }, timeout);
    timeoutTimer.unref();

    try {
      // Assemble final prompt with mode suffix
      const { getModeSuffixPrompt } = await import('../config/mode-prompts.js');
      const suffix = getModeSuffixPrompt(options.mode);
      const finalPrompt = suffix ? `${options.prompt}\n\n${suffix}` : options.prompt;

      await this.executeSession(handle, finalPrompt, abortController.signal, options);
    } catch (err: any) {
      // Only mark failed if not already in a terminal state
      // (subclass may have already called markCompleted/markFailed)
      if (handle.isAlive()) {
        if (abortController.signal.aborted) {
          handle.markCancelled(`${this.displayName} session aborted`);
        } else {
          console.error(`[${this.id}] Task ${taskId} failed:`, err);
          handle.markFailed(
            `${this.displayName} error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
      handle.unregisterAbort();
      this.onSpawnFinished(taskId);
    }
  }

  // ---------------------------------------------------------------------------
  // Hooks — override in subclasses to track abort controllers
  // ---------------------------------------------------------------------------

  /** Called after abort controller is created. Track it for abort(). */
  protected onSpawnStarted(_taskId: string, _abortController: AbortController): void {}

  /** Called in finally block. Clean up controller tracking. */
  protected onSpawnFinished(_taskId: string): void {}

  // ---------------------------------------------------------------------------
  // Default abort — uses processRegistry kill escalation
  // ---------------------------------------------------------------------------

  async abort(taskId: string, _reason?: string): Promise<boolean> {
    const { processRegistry } = await import('../services/process-registry.js');
    return processRegistry.killTask(taskId);
  }

  // ---------------------------------------------------------------------------
  // Default shutdown — no-op, subclasses override
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {}
}
