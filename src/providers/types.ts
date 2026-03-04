/**
 * Provider Abstraction Layer — Core Interfaces
 *
 * Every AI provider (Copilot SDK, Claude Agent SDK, OpenAI Codex SDK, etc.)
 * implements ProviderAdapter. The ProviderRegistry manages provider selection,
 * fallback chains, and lifecycle.
 */

import type { AgentMode, Provider, ReasoningEffort } from '../types.js';
import type { TaskHandle } from './task-handle.js';

// ============================================================================
// Provider Capabilities
// ============================================================================

/**
 * Declares what a provider supports. Used by tools (send_message, cancel_task)
 * to check capabilities before dispatching.
 */
export interface ProviderCapabilities {
  /** Can resume a completed session with a new message (Copilot: true) */
  supportsSessionResume: boolean;
  /** Can handle ask_user prompts via question registry (Copilot: true) */
  supportsUserInput: boolean;
  /** Has native parallel sub-agent execution (Copilot fleet RPC: true) */
  supportsFleetMode: boolean;
  /** Supports mid-session credential rotation (Copilot PAT rotation: true) */
  supportsCredentialRotation: boolean;
  /** Maximum concurrent sessions this provider can run */
  maxConcurrency: number;
}

// ============================================================================
// Provider Spawn Options
// ============================================================================

/**
 * Options passed to ProviderAdapter.spawn().
 * Task creation happens in shared-spawn.ts BEFORE this is called —
 * the provider receives a taskId and is responsible for RUNNING→COMPLETED|FAILED.
 */
export interface ProviderSpawnOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  /** Model name in provider-specific format (from resolveModelForProvider, may differ from canonical ModelId) */
  model: string;
  timeout: number;
  mode: AgentMode;
  reasoningEffort?: ReasoningEffort;
  /** Resume an existing session (Copilot-specific) */
  resumeSessionId?: string;
  /** Labels from the original spawn request */
  labels?: string[];
  /** Task type for model resolution */
  taskType?: import('../types.js').TaskTypeName;
}

// ============================================================================
// Availability Check
// ============================================================================

/**
 * Result of ProviderAdapter.checkAvailability().
 * Used by the registry to skip unavailable providers during selection.
 */
export interface AvailabilityResult {
  available: boolean;
  /** Human-readable reason when unavailable */
  reason?: string;
  /** Hint for when to retry (rate limit cooldown) */
  retryAfterMs?: number;
}

// ============================================================================
// Fallback Request
// ============================================================================

/**
 * Passed to the fallback handler when a provider fails mid-task.
 */
export interface FallbackRequest {
  taskId: string;
  failedProviderId: Provider;
  reason: string;
  errorMessage?: string;
  cwd?: string;
  promptOverride?: string;
  /** If true, the fallback handler awaits the fallback session completion */
  awaitCompletion?: boolean;
}

// ============================================================================
// Chain Entry
// ============================================================================

/**
 * An entry in the provider chain parsed from PROVIDER_CHAIN env var.
 * Example: "copilot,codex,!claude-cli"
 *   → [{ id: 'copilot', fallbackOnly: false }, { id: 'codex', fallbackOnly: false }, { id: 'claude-cli', fallbackOnly: true }]
 */
export interface ChainEntry {
  id: Provider;
  /** If true, this provider is only used as a fallback (skipped during primary selection) */
  fallbackOnly: boolean;
}

// ============================================================================
// Provider Adapter Interface
// ============================================================================

/**
 * The contract every AI provider must implement.
 *
 * Lifecycle:
 * 1. Constructed at startup, registered with ProviderRegistry
 * 2. checkAvailability() called during provider selection
 * 3. spawn() called with a taskId (task already created in PENDING state)
 * 4. Provider drives: PENDING → RUNNING → COMPLETED|FAILED
 * 5. abort() called on cancel_task
 * 6. shutdown() called on server exit
 *
 * Providers must:
 * - Use console.error for all logging (never console.log)
 * - Use taskManager.updateTask() for state changes (never spread)
 * - Check isTerminalStatus() after every await
 * - Register with processRegistry for kill escalation
 * - Call .unref() on all timers
 */
export interface ProviderAdapter {
  /** Unique identifier matching the Provider type union (e.g., 'copilot', 'claude-cli', 'codex') */
  readonly id: Provider;
  /** Human-readable name for logs and UI */
  readonly displayName: string;

  /**
   * Check if this provider can accept new tasks right now.
   * Called synchronously during provider selection — must be fast.
   */
  checkAvailability(): AvailabilityResult;

  /** Declare provider capabilities for tool-level checks */
  getCapabilities(): ProviderCapabilities;

  /**
   * Execute a task. The task is already created in PENDING state.
   * Provider must:
   * 1. Update status to RUNNING
   * 2. Execute the prompt
   * 3. Update status to COMPLETED or FAILED
   *
   * This is called inside setImmediate — it runs asynchronously.
   * Errors should be caught and reflected as FAILED status, not thrown.
   */
  spawn(options: ProviderSpawnOptions, handle?: TaskHandle): Promise<void>;

  /**
   * Abort a running task. Called by cancel_task and timeout handlers.
   * Returns true if the abort was initiated successfully.
   */
  abort(taskId: string, reason?: string): Promise<boolean>;

  /**
   * Send a follow-up message to an existing session.
   * Only available if supportsSessionResume is true.
   * Returns the new task ID.
   */
  sendMessage?(taskId: string, message: string, options: ProviderSpawnOptions): Promise<string>;

  /**
   * Graceful shutdown. Called during server exit.
   * Must abort all active sessions and clean up resources.
   */
  shutdown(): Promise<void>;

  /** Runtime statistics for the system:///status resource */
  getStats(): Record<string, unknown>;
}
