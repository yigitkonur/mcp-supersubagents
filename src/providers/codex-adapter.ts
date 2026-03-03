/**
 * OpenAI Codex SDK Provider Adapter
 *
 * Full integration of @openai/codex-sdk as a provider.
 * Extends BaseProviderAdapter for abort/timeout/cleanup boilerplate.
 * Implements executeSession() with Codex thread streaming.
 *
 * Resilience: Cockatiel bulkhead (concurrency) + circuit breaker (health).
 *
 * Configuration via environment variables:
 * - OPENAI_API_KEY or CODEX_API_KEY (required)
 * - CODEX_PATH — override CLI binary path
 * - CODEX_MODEL — default model (default: o4-mini)
 * - CODEX_SANDBOX_MODE — sandbox mode (default: workspace-write)
 * - CODEX_APPROVAL_POLICY — approval policy (default: never)
 * - MAX_CONCURRENT_CODEX_SESSIONS — max concurrency (default: 5)
 * - DISABLE_CODEX_FALLBACK — disable Codex in fallback chain (default: false)
 */

import type {
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
} from './types.js';
import type { TaskHandle } from './task-handle.js';
import { BaseProviderAdapter } from './base-adapter.js';
import { createProviderPolicy, type ProviderPolicy } from './resilience.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CODEX_API_KEY = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';
const CODEX_PATH = process.env.CODEX_PATH || undefined;
const CODEX_MODEL = process.env.CODEX_MODEL || 'o4-mini';
const CODEX_SANDBOX_MODE = (process.env.CODEX_SANDBOX_MODE || 'workspace-write') as
  'read-only' | 'workspace-write' | 'danger-full-access';
const CODEX_APPROVAL_POLICY = (process.env.CODEX_APPROVAL_POLICY || 'never') as
  'never' | 'on-request' | 'on-failure' | 'untrusted';

const parsedMaxCodex = parseInt(process.env.MAX_CONCURRENT_CODEX_SESSIONS || '5', 10);
const MAX_CONCURRENCY = Number.isFinite(parsedMaxCodex) && parsedMaxCodex > 0 ? parsedMaxCodex : 5;

const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: false,
  supportsUserInput: false,
  supportsFleetMode: false,
  supportsCredentialRotation: false,
  maxConcurrency: MAX_CONCURRENCY,
};

// ---------------------------------------------------------------------------
// Resilience policy (replaces manual activeSessions counter)
// ---------------------------------------------------------------------------

const policy: ProviderPolicy = createProviderPolicy({
  providerId: 'codex',
  maxConcurrency: MAX_CONCURRENCY,
  queueSize: 0,
  breakerThreshold: 5,
  halfOpenAfterMs: 30_000,
});

// ---------------------------------------------------------------------------
// Adapter Implementation
// ---------------------------------------------------------------------------

export class CodexProviderAdapter extends BaseProviderAdapter {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex SDK';

  /** AbortControllers for running sessions, keyed by taskId */
  private activeControllers = new Map<string, AbortController>();

  // --- Base class hooks for controller tracking ---

  protected onSpawnStarted(taskId: string, abortController: AbortController): void {
    this.activeControllers.set(taskId, abortController);
  }

  protected onSpawnFinished(taskId: string): void {
    this.activeControllers.delete(taskId);
  }

  // --- Provider interface ---

  checkAvailability(): AvailabilityResult {
    if (process.env.DISABLE_CODEX_FALLBACK === 'true') {
      return {
        available: false,
        reason: 'Codex disabled (DISABLE_CODEX_FALLBACK=true)',
      };
    }
    if (!CODEX_API_KEY) {
      return {
        available: false,
        reason: 'No API key configured (set OPENAI_API_KEY or CODEX_API_KEY)',
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

  /**
   * Codex session execution — the only method this adapter needs to implement.
   * Base class handles: handle creation, abort controller, timeout, mode suffix, cleanup.
   */
  protected async executeSession(
    handle: TaskHandle,
    prompt: string,
    signal: AbortSignal,
    options: ProviderSpawnOptions,
  ): Promise<void> {
    const { Codex } = await import('@openai/codex-sdk');
    const { model } = options;

    handle.markRunning();
    handle.setProvider('codex');

    // Execute through resilience policy (bulkhead + circuit breaker)
    await policy.execute(async () => {
      const codex = new Codex({
        apiKey: CODEX_API_KEY,
        codexPathOverride: CODEX_PATH,
      });

      const codexModel = model === 'sonnet' || model === 'opus' ? CODEX_MODEL : (model || CODEX_MODEL);

      const thread = codex.startThread({
        model: codexModel,
        workingDirectory: options.cwd,
        sandboxMode: CODEX_SANDBOX_MODE,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        skipGitRepoCheck: true,
      });

      // prompt already has mode suffix (base class assembled it)
      const { events } = await thread.runStreamed(prompt, { signal });

      // Metrics tracking
      let turnCount = 0;
      let totalTokens = { input: 0, output: 0 };
      const toolMetrics: Record<string, { count: number; successCount: number; failureCount: number }> = {};

      for await (const event of events) {
        if (handle.isTerminal()) break;

        switch (event.type) {
          case 'thread.started':
            handle.setSessionId(event.thread_id);
            handle.writeOutput(`[codex] Thread started: ${event.thread_id}`);
            break;

          case 'turn.started':
            turnCount++;
            handle.writeOutput(`--- Turn ${turnCount} ---`);
            break;

          case 'turn.completed':
            if (event.usage) {
              totalTokens.input += event.usage.input_tokens;
              totalTokens.output += event.usage.output_tokens;
              handle.writeOutput(`[usage] in=${event.usage.input_tokens} out=${event.usage.output_tokens}`);
            }
            break;

          case 'turn.failed':
            handle.writeOutput(`[error] Turn failed: ${event.error.message}`);
            break;

          case 'item.started':
            switch (event.item.type) {
              case 'agent_message':
                break;
              case 'reasoning':
                handle.writeOutput(`[reasoning] ${event.item.text.slice(0, 200)}`);
                break;
              case 'command_execution':
                handle.writeOutput(`[tool] ${event.item.command}`);
                break;
              case 'file_change':
                for (const change of event.item.changes) {
                  handle.writeOutput(`[file] ${change.path} (${change.kind})`);
                }
                break;
              case 'mcp_tool_call':
                handle.writeOutput(`[tool] MCP:${event.item.server} ${event.item.tool}`);
                break;
              case 'web_search':
                handle.writeOutput(`[search] ${event.item.query}`);
                break;
              case 'todo_list':
                handle.writeOutput(
                  `[todo] ${event.item.items.map((i: any) => `${i.completed ? '✓' : '○'} ${i.text}`).join(', ')}`,
                );
                break;
              case 'error':
                handle.writeOutput(`[error] ${event.item.message}`);
                break;
            }
            break;

          case 'item.updated':
            if (event.item.type === 'agent_message') {
              handle.writeOutput(event.item.text);
            }
            break;

          case 'item.completed':
            switch (event.item.type) {
              case 'command_execution': {
                const exit = event.item.exit_code ?? -1;
                const status = event.item.status;
                const name = 'command_execution';
                if (!toolMetrics[name]) toolMetrics[name] = { count: 0, successCount: 0, failureCount: 0 };
                toolMetrics[name].count++;
                if (status === 'completed') toolMetrics[name].successCount++;
                else toolMetrics[name].failureCount++;
                handle.writeOutput(`[tool] command exit=${exit} (${status})`);
                break;
              }
              case 'file_change': {
                const name = 'file_change';
                if (!toolMetrics[name]) toolMetrics[name] = { count: 0, successCount: 0, failureCount: 0 };
                toolMetrics[name].count++;
                if (event.item.status === 'completed') toolMetrics[name].successCount++;
                else toolMetrics[name].failureCount++;
                handle.writeOutput(`[file] ${event.item.changes.length} changes ${event.item.status}`);
                break;
              }
              case 'mcp_tool_call': {
                const name = `mcp:${event.item.server}:${event.item.tool}`;
                if (!toolMetrics[name]) toolMetrics[name] = { count: 0, successCount: 0, failureCount: 0 };
                toolMetrics[name].count++;
                if (event.item.status === 'completed') toolMetrics[name].successCount++;
                else toolMetrics[name].failureCount++;
                handle.writeOutput(`[tool] MCP:${event.item.server} ${event.item.tool} ${event.item.status}`);
                break;
              }
            }
            break;

          case 'error':
            handle.writeOutput(`[error] ${event.message}`);
            break;
        }
      }

      // Mark completed inside policy.execute() so circuit breaker sees success
      if (handle.isAlive()) {
        handle.writeOutput(`[summary] ${turnCount} turns, ${totalTokens.input + totalTokens.output} tokens`);
        handle.markCompleted({
          turnCount,
          totalTokens,
          toolMetrics: Object.fromEntries(
            Object.entries(toolMetrics).map(([name, m]) => [
              name,
              {
                toolName: name,
                executionCount: m.count,
                successCount: m.successCount,
                failureCount: m.failureCount,
                totalDurationMs: 0,
              },
            ]),
          ),
        });
      }
    });
  }

  async abort(taskId: string, _reason?: string): Promise<boolean> {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    for (const [taskId, controller] of this.activeControllers) {
      console.error(`[codex-adapter] Shutting down session for task ${taskId}`);
      controller.abort();
    }
    this.activeControllers.clear();
  }

  getStats(): Record<string, unknown> {
    const policyStats = policy.getStats();
    return {
      circuitState: policyStats.circuitState,
      executionSlots: policyStats.executionSlots,
      queueSlots: policyStats.queueSlots,
      maxConcurrency: MAX_CONCURRENCY,
      apiKeyConfigured: !!CODEX_API_KEY,
      model: CODEX_MODEL,
      sandboxMode: CODEX_SANDBOX_MODE,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      disabled: process.env.DISABLE_CODEX_FALLBACK === 'true',
    };
  }
}
