/**
 * Claude Agent SDK Provider Adapter
 *
 * Thin wrapper around the existing claude-code-runner.ts.
 * Claude is typically used as a fallback provider when Copilot/Codex
 * accounts are exhausted, but can also be configured as primary.
 *
 * Resilience: Cockatiel bulkhead (concurrency) + circuit breaker (health).
 *
 * Note: runClaudeCodeSession() manages its own state transitions
 * (RUNNING → COMPLETED/FAILED) internally. The TaskHandle is accepted
 * for interface conformance but the runner uses taskManager directly
 * until fully migrated.
 */

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
} from './types.js';
import type { TaskHandle } from './task-handle.js';
import { createProviderPolicy, type ProviderPolicy } from './resilience.js';

const parsedMax = parseInt(process.env.MAX_CONCURRENT_CLAUDE_FALLBACKS || '3', 10);
const MAX_CONCURRENCY = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 3;

const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: false,
  supportsUserInput: true,
  supportsFleetMode: false,
  supportsCredentialRotation: false,
  maxConcurrency: MAX_CONCURRENCY,
};

// ---------------------------------------------------------------------------
// Resilience policy
// ---------------------------------------------------------------------------

const policy: ProviderPolicy = createProviderPolicy({
  providerId: 'claude-cli',
  maxConcurrency: MAX_CONCURRENCY,
  queueSize: 0,
  breakerThreshold: 5,
  halfOpenAfterMs: 30_000,
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly id = 'claude-cli';
  readonly displayName = 'Claude Agent SDK';

  checkAvailability(): AvailabilityResult {
    if (process.env.DISABLE_CLAUDE_CODE_FALLBACK === 'true') {
      return {
        available: false,
        reason: 'Claude fallback disabled (DISABLE_CLAUDE_CODE_FALLBACK=true)',
      };
    }
    if (!policy.isHealthy()) {
      return {
        available: false,
        reason: `Circuit breaker open (${policy.getStats().circuitState})`,
        retryAfterMs: 30_000,
      };
    }
    if (policy.isFull()) {
      return {
        available: false,
        reason: `Concurrency limit reached (${policy.getStats().executionSlots}/${MAX_CONCURRENCY})`,
        retryAfterMs: 10_000,
      };
    }
    return { available: true };
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  async spawn(options: ProviderSpawnOptions, handle?: TaskHandle): Promise<void> {
    const { runClaudeCodeSession } = await import('../services/claude-code-runner.js');

    // Execute through resilience policy (bulkhead + circuit breaker).
    // runClaudeCodeSession manages state transitions internally.
    await policy.execute(async () => {
      await runClaudeCodeSession(
        options.taskId,
        options.prompt,
        options.cwd,
        options.timeout,
        {
          preferredModel: options.model,
        },
      );
    });
  }

  async abort(taskId: string, reason?: string): Promise<boolean> {
    // Clear any pending question immediately (mirrors Codex adapter abort flow)
    const { questionRegistry } = await import('../services/question-registry.js');
    if (questionRegistry.hasPendingQuestion(taskId)) {
      console.error(`[claude-adapter] Abort: clearing pending question for task ${taskId}`);
      questionRegistry.clearQuestion(taskId, 'task aborted');
    }

    const { abortClaudeCodeSession } = await import('../services/claude-code-runner.js');
    return abortClaudeCodeSession(taskId, reason ?? 'Task cancelled');
  }

  // sendMessage not implemented — supportsSessionResume is false

  async shutdown(): Promise<void> {
    const { abortAllFallbackSessions } = await import('../services/claude-code-runner.js');
    abortAllFallbackSessions('Server shutdown');
  }

  getStats(): Record<string, unknown> {
    const policyStats = policy.getStats();
    return {
      circuitState: policyStats.circuitState,
      executionSlots: policyStats.executionSlots,
      queueSlots: policyStats.queueSlots,
      maxConcurrency: MAX_CONCURRENCY,
      disabled: process.env.DISABLE_CLAUDE_CODE_FALLBACK === 'true',
    };
  }
}
