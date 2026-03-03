/**
 * Provider Resilience Policies — Cockatiel-based
 *
 * Composable resilience primitives for provider adapters:
 * - Bulkhead: replaces manual activeSessions counters with proper queuing
 * - Circuit Breaker: detects unhealthy providers (consecutive failures → open circuit)
 *
 * Each adapter creates its own policy via createProviderPolicy().
 * The policy is an internal implementation detail — the registry only sees
 * checkAvailability(), which adapters wire to policy health/capacity.
 */

import {
  bulkhead,
  circuitBreaker,
  handleAll,
  wrap,
  ConsecutiveBreaker,
  CircuitState,
} from 'cockatiel';

// Re-export error types so adapters/callers can distinguish policy rejections
export {
  BrokenCircuitError,
  BulkheadRejectedError,
  IsolatedCircuitError,
  isBrokenCircuitError,
  isBulkheadRejectedError,
} from 'cockatiel';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProviderPolicyConfig {
  /** Provider identifier for logging */
  providerId: string;
  /** Max concurrent sessions. Infinity = skip bulkhead, circuit breaker only. */
  maxConcurrency: number;
  /** Queue size for excess requests when bulkhead is full (default: 0 = reject immediately) */
  queueSize?: number;
  /** Consecutive failures before circuit opens (default: 5) */
  breakerThreshold?: number;
  /** Time in ms after open before half-open test (default: 30_000) */
  halfOpenAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Policy Interface
// ---------------------------------------------------------------------------

export interface ProviderPolicyStats {
  circuitState: string;
  executionSlots: number;
  queueSlots: number;
}

export interface ProviderPolicy {
  /**
   * Execute a function through the policy chain (bulkhead → circuit breaker).
   * Throws BulkheadRejectedError if at capacity, BrokenCircuitError if circuit is open.
   */
  execute<T>(fn: (context: { signal: AbortSignal }) => Promise<T>): Promise<T>;

  /** True if the circuit breaker is closed or half-open (accepting requests) */
  isHealthy(): boolean;

  /** True if the bulkhead has no remaining execution slots */
  isFull(): boolean;

  /** Runtime statistics for getStats() / system:///status */
  getStats(): ProviderPolicyStats;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProviderPolicy(config: ProviderPolicyConfig): ProviderPolicy {
  const {
    providerId,
    maxConcurrency,
    queueSize = 0,
    breakerThreshold = 5,
    halfOpenAfterMs = 30_000,
  } = config;

  // Circuit breaker: opens after N consecutive failures, half-opens after cooldown
  const cb = circuitBreaker(handleAll, {
    halfOpenAfter: halfOpenAfterMs,
    breaker: new ConsecutiveBreaker(breakerThreshold),
  });

  // Log circuit breaker state changes (Event<T> in cockatiel is a callable)
  cb.onBreak(() => {
    console.error(`[resilience:${providerId}] Circuit OPEN — ${breakerThreshold} consecutive failures`);
  });
  cb.onReset(() => {
    console.error(`[resilience:${providerId}] Circuit CLOSED — provider recovered`);
  });
  cb.onHalfOpen(() => {
    console.error(`[resilience:${providerId}] Circuit HALF-OPEN — testing provider`);
  });

  const isHealthy = (): boolean =>
    cb.state !== CircuitState.Open && cb.state !== CircuitState.Isolated;

  const circuitStateName = (): string => {
    switch (cb.state) {
      case CircuitState.Closed: return 'closed';
      case CircuitState.Open: return 'open';
      case CircuitState.HalfOpen: return 'half-open';
      case CircuitState.Isolated: return 'isolated';
      default: return 'unknown';
    }
  };

  // If maxConcurrency is finite, compose bulkhead + circuit breaker
  if (Number.isFinite(maxConcurrency) && maxConcurrency > 0) {
    const bh = bulkhead(maxConcurrency, queueSize);

    bh.onReject(() => {
      console.error(`[resilience:${providerId}] Bulkhead REJECTED — at capacity (${maxConcurrency})`);
    });

    // Compose: outer bulkhead (limits concurrency) → inner circuit breaker (detects failures)
    const composed = wrap(bh, cb);

    return {
      execute: <T>(fn: (context: { signal: AbortSignal }) => Promise<T>): Promise<T> =>
        composed.execute(fn),
      isHealthy,
      isFull: () => bh.executionSlots === 0,
      getStats: () => ({
        circuitState: circuitStateName(),
        executionSlots: bh.executionSlots,
        queueSlots: bh.queueSlots,
      }),
    };
  }

  // No bulkhead needed (Infinity concurrency) — circuit breaker only
  return {
    execute: <T>(fn: (context: { signal: AbortSignal }) => Promise<T>): Promise<T> =>
      cb.execute(fn),
    isHealthy,
    isFull: () => false,
    getStats: () => ({
      circuitState: circuitStateName(),
      executionSlots: Infinity,
      queueSlots: Infinity,
    }),
  };
}
