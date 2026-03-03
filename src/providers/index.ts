/**
 * Provider Abstraction Layer — Public API
 *
 * Re-exports the provider system for clean imports:
 *   import { providerRegistry, triggerFallback } from './providers/index.js';
 */

export type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
  FallbackRequest,
  ChainEntry,
} from './types.js';

export { providerRegistry, parseChainString } from './registry.js';
export type { ProviderSelection } from './registry.js';

export { triggerFallback, isFallbackEnabled } from './fallback-handler.js';

export type { TaskHandle, SessionMetrics } from './task-handle.js';
export { createTaskHandle } from './task-handle-impl.js';

export { BaseProviderAdapter } from './base-adapter.js';
export { CopilotProviderAdapter } from './copilot-adapter.js';
export { ClaudeProviderAdapter } from './claude-adapter.js';
export { CodexProviderAdapter } from './codex-adapter.js';

export { createProviderPolicy } from './resilience.js';
export type { ProviderPolicy, ProviderPolicyConfig, ProviderPolicyStats } from './resilience.js';
export { BrokenCircuitError, BulkheadRejectedError, isBrokenCircuitError, isBulkheadRejectedError } from './resilience.js';
