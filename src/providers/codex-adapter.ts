/**
 * OpenAI Codex SDK Provider Adapter
 *
 * Full integration of @openai/codex-sdk as a provider.
 * Extends BaseProviderAdapter for abort/timeout/cleanup boilerplate.
 * Implements executeSession() with Codex thread streaming.
 *
 * Two execution modes:
 * - App-server mode (default): Spawns `codex app-server --listen stdio://`
 *   with full JSON-RPC 2.0 protocol support, enabling user input (ask_user),
 *   session resume (thread/resume), and graceful cancellation (turn/interrupt).
 * - SDK mode (fallback): Uses @openai/codex-sdk's Codex class → thread.runStreamed().
 *   Opt-in via CODEX_USE_SDK=true or when app-server binary is not found.
 *
 * Resilience: Cockatiel bulkhead (concurrency) + circuit breaker (health).
 *
 * Configuration via environment variables:
 * - OPENAI_API_KEY or CODEX_API_KEY (optional if Codex CLI has its own auth via ~/.codex/auth.json)
 * - CODEX_PATH — override CLI binary path
 * - CODEX_MODEL — default model (default: o4-mini)
 * - CODEX_SANDBOX_MODE — sandbox mode (default: workspace-write)
 * - CODEX_APPROVAL_POLICY — approval policy (default: never)
 * - MAX_CONCURRENT_CODEX_SESSIONS — max concurrency (default: 5)
 * - DISABLE_CODEX_FALLBACK — disable Codex in fallback chain (default: false)
 * - CODEX_USE_SDK — force SDK mode instead of app-server (default: false)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
} from './types.js';
import type { TaskHandle } from './task-handle.js';
import { BaseProviderAdapter } from './base-adapter.js';
import { createProviderPolicy, type ProviderPolicy } from './resilience.js';
import { getEmbeddedReasoningEffort } from '../models.js';
import {
  CodexAppServerClient,
  CodexRpcError,
  findCodexBinary,
  type UserInputRequestParams,
} from './codex-app-server.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CODEX_API_KEY = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';

/** Check if the Codex CLI has its own auth configured (ChatGPT OAuth or API key in auth.json). */
const HAS_CLI_AUTH = existsSync(join(homedir(), '.codex', 'auth.json'));
const CODEX_PATH = process.env.CODEX_PATH || undefined;
const CODEX_MODEL = process.env.CODEX_MODEL || 'o4-mini';
const CODEX_SANDBOX_MODE = (process.env.CODEX_SANDBOX_MODE || 'workspace-write') as
  'read-only' | 'workspace-write' | 'danger-full-access';
const CODEX_APPROVAL_POLICY = (process.env.CODEX_APPROVAL_POLICY || 'never') as
  'never' | 'on-request' | 'on-failure' | 'untrusted';

const parsedMaxCodex = parseInt(process.env.MAX_CONCURRENT_CODEX_SESSIONS || '5', 10);
const MAX_CONCURRENCY = Number.isFinite(parsedMaxCodex) && parsedMaxCodex > 0 ? parsedMaxCodex : 5;

/**
 * Auto-detect app-server mode: default to app-server when the codex binary is found.
 * Opt-out with CODEX_USE_SDK=true to force SDK mode.
 */
const FORCE_SDK_MODE = process.env.CODEX_USE_SDK === 'true';

function detectAppServerAvailable(): boolean {
  if (FORCE_SDK_MODE) return false;
  try {
    const binary = findCodexBinary(CODEX_PATH);
    if (binary === 'codex') {
      const lookup = process.platform === 'win32' ? 'where' : 'which';
      return spawnSync(lookup, ['codex'], { stdio: 'ignore' }).status === 0;
    }
    return existsSync(binary);
  } catch {
    return false;
  }
}

const USE_APP_SERVER = detectAppServerAvailable();

// Startup log — mode, auth source, configuration
console.error(
  `[codex-adapter] Init: mode=${USE_APP_SERVER ? 'app-server' : 'SDK'}${FORCE_SDK_MODE ? ' (forced SDK)' : ''}, ` +
  `auth=${CODEX_API_KEY ? 'api-key' : HAS_CLI_AUTH ? 'cli-auth' : 'none'}, ` +
  `model=${CODEX_MODEL}, sandbox=${CODEX_SANDBOX_MODE}, concurrency=${MAX_CONCURRENCY}`,
);

const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: true,
  supportsUserInput: true,
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

  /** Active CodexAppServerClient instances, keyed by taskId (for abort + sendMessage) */
  private activeClients = new Map<string, CodexAppServerClient>();

  // --- Base class hooks for controller tracking ---

  protected onSpawnStarted(taskId: string, abortController: AbortController): void {
    this.activeControllers.set(taskId, abortController);
  }

  protected onSpawnFinished(taskId: string): void {
    this.activeControllers.delete(taskId);
    // Don't remove from activeClients here — sendMessage may need the client
    // Client cleanup happens when the task completes/fails or on explicit destroy
  }

  // --- Provider interface ---

  checkAvailability(): AvailabilityResult {
    if (process.env.DISABLE_CODEX_FALLBACK === 'true') {
      return {
        available: false,
        reason: 'Codex disabled (DISABLE_CODEX_FALLBACK=true)',
      };
    }
    if (!CODEX_API_KEY && !HAS_CLI_AUTH) {
      return {
        available: false,
        reason: 'No auth configured (set OPENAI_API_KEY or CODEX_API_KEY, or run `codex auth` for CLI auth)',
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
   * Codex session execution — delegates to app-server or SDK mode.
   * Base class handles: handle creation, abort controller, timeout, mode suffix, cleanup.
   */
  protected async executeSession(
    handle: TaskHandle,
    prompt: string,
    signal: AbortSignal,
    options: ProviderSpawnOptions,
  ): Promise<void> {
    if (USE_APP_SERVER) {
      await this.executeSessionWithAppServer(handle, prompt, signal, options);
    } else {
      await this.executeSessionWithSDK(handle, prompt, signal, options);
    }
  }

  /**
   * SDK mode: Uses @openai/codex-sdk's Codex class → thread.runStreamed().
   * No user input support — events are filtered by the SDK.
   */
  private async executeSessionWithSDK(
    handle: TaskHandle,
    prompt: string,
    signal: AbortSignal,
    options: ProviderSpawnOptions,
  ): Promise<void> {
    const { Codex } = await import('@openai/codex-sdk');
    const { model, reasoningEffort } = options;

    // Execute through resilience policy (bulkhead + circuit breaker)
    await policy.execute(async () => {
      handle.markRunning();
      handle.setProvider('codex');

      const codex = new Codex({
        ...(CODEX_API_KEY ? { apiKey: CODEX_API_KEY } : {}),
        codexPathOverride: CODEX_PATH,
      });

      const codexModel = model || CODEX_MODEL;

      const thread = codex.startThread({
        model: codexModel,
        workingDirectory: options.cwd,
        sandboxMode: CODEX_SANDBOX_MODE,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        skipGitRepoCheck: true,
        ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
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
              handle.writeOutputFileOnly(`[usage] in=${event.usage.input_tokens} out=${event.usage.output_tokens}`);
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
                handle.writeOutputFileOnly(`[reasoning] ${event.item.text.slice(0, 200)}`);
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

  /**
   * App-server mode: Spawns `codex app-server --listen stdio://` with full
   * JSON-RPC 2.0 protocol support. Enables user input (ask_user) via the
   * `item/tool/requestUserInput` server request flow, session resume via
   * `thread/resume`, and graceful cancellation via `turn/interrupt`.
   */
  private async executeSessionWithAppServer(
    handle: TaskHandle,
    prompt: string,
    signal: AbortSignal,
    options: ProviderSpawnOptions,
  ): Promise<void> {
    const { questionRegistry } = await import('../services/question-registry.js');
    const { model, reasoningEffort } = options;
    const taskId = options.taskId;

    await policy.execute(async () => {
      handle.markRunning();
      handle.setProvider('codex');

      const codexModel = model || CODEX_MODEL;
      console.error(
        `[codex-adapter] App-server session starting: task=${taskId}, model=${codexModel}, ` +
        `cwd=${options.cwd}, resume=${!!options.resumeSessionId}`,
      );

      const client = new CodexAppServerClient({
        codexPath: CODEX_PATH,
        apiKey: CODEX_API_KEY || undefined,
      });

      // Track client for abort/sendMessage access
      this.activeClients.set(taskId, client);

      try {
        // 1. Start the app-server process (registers with processRegistry)
        await client.start(signal, taskId);
        handle.writeOutput('[codex] App-server started (JSON-RPC mode)');

        // 2. Start or resume a thread
        const threadOptions = {
          model: codexModel,
          cwd: options.cwd,
          sandboxMode: CODEX_SANDBOX_MODE,
          approvalPolicy: CODEX_APPROVAL_POLICY,
        };

        let threadId: string;
        if (options.resumeSessionId) {
          // Resuming an existing session (called from sendMessage flow)
          threadId = await client.resumeThread(options.resumeSessionId, threadOptions);
          handle.writeOutput(`[codex] Thread resumed: ${threadId}`);
        } else {
          threadId = await client.startThread(threadOptions);
          handle.writeOutput(`[codex] Thread started: ${threadId}`);
        }
        handle.setSessionId(threadId);

        // 3. Track pending questions so they can be cleaned up on teardown.
        let questionPending = false;

        // 4. Run a turn and process messages
        let turnCount = 0;
        let totalTokens = { input: 0, output: 0 };
        const toolMetrics: Record<string, { count: number; successCount: number; failureCount: number }> = {};

        for await (const msg of client.runTurn(prompt, { reasoningEffort })) {
          if (handle.isTerminal()) break;

          if (msg.kind === 'notification') {
            this.handleAppServerNotification(handle, msg.method, msg.params, {
              turnCount: () => turnCount,
              incrementTurn: () => { turnCount++; },
              addTokens: (input: number, output: number) => {
                totalTokens.input += input;
                totalTokens.output += output;
              },
              trackTool: (name: string, success: boolean) => {
                if (!toolMetrics[name]) toolMetrics[name] = { count: 0, successCount: 0, failureCount: 0 };
                toolMetrics[name].count++;
                if (success) toolMetrics[name].successCount++;
                else toolMetrics[name].failureCount++;
              },
            });
          } else if (msg.kind === 'request') {
            await this.handleAppServerRequest(
              handle, client, msg.id, msg.method, msg.params, taskId,
              questionRegistry, { setQuestionPending: (v: boolean) => { questionPending = v; } },
            );
          }
        }

        // Mark completed
        if (handle.isAlive()) {
          handle.writeOutput(`[summary] ${turnCount} turns, ${totalTokens.input + totalTokens.output} tokens (app-server)`);
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
      } catch (err) {
        // Classify Codex-specific errors for better diagnostics
        if (err instanceof CodexRpcError) {
          const kind = typeof err.codexErrorInfo === 'string'
            ? err.codexErrorInfo
            : err.codexErrorInfo?.kind || 'unknown';
          console.error(
            `[codex-adapter] RPC error for task ${taskId}: code=${err.code}, kind=${kind}, msg=${err.message}`,
          );
          if (err.isContextWindowExceeded) {
            handle.writeOutput(`[error] Context window exceeded — conversation too long`);
          } else if (err.isUsageLimitExceeded) {
            handle.writeOutput(`[error] Usage limit exceeded — API quota exhausted`);
          } else if (err.isHttpConnectionFailed) {
            handle.writeOutput(`[error] HTTP connection failed — cannot reach OpenAI API`);
          }
        } else {
          console.error(`[codex-adapter] Session error for task ${taskId}:`, err);
        }
        // Re-throw so base class handles the state transition
        throw err;
      } finally {
        // Clear any pending question before destroying
        if (questionRegistry.hasPendingQuestion(taskId)) {
          console.error(`[codex-adapter] Clearing zombie question for task ${taskId}`);
          questionRegistry.clearQuestion(taskId, 'codex session ended');
        }
        if (!client.isDestroyed) {
          console.error(`[codex-adapter] Destroying completed app-server client for task ${taskId}`);
          client.destroy();
        }
        this.activeClients.delete(taskId);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // sendMessage — resume an existing session via thread/resume
  // ---------------------------------------------------------------------------

  /**
   * Send a follow-up message to an existing Codex session.
   * Creates a NEW task (same pattern as Copilot) and uses thread/resume.
   * Returns the new task ID.
   */
  async sendMessage(taskId: string, message: string, options: ProviderSpawnOptions): Promise<string> {
    const { taskManager } = await import('../services/task-manager.js');
    const { createTaskHandle } = await import('./task-handle-impl.js');

    const originalTask = taskManager.getTask(taskId);
    if (!originalTask?.sessionId) {
      throw new Error('No session to resume — original task has no sessionId');
    }

    console.error(
      `[codex-adapter] sendMessage: task=${taskId}, threadId=${originalTask.sessionId}, ` +
      `msgLen=${message.length}`,
    );

    // Create a new task for the follow-up
    const newTask = taskManager.createTask(message, options.cwd, options.model, {
      isResume: true,
      labels: [...(originalTask.labels || []), `continued-from:${taskId}`],
      provider: 'codex',
      timeout: options.timeout,
    });

    const newTaskId = newTask.id;
    const existingThreadId = originalTask.sessionId;

    // Execute asynchronously (return task ID immediately, like shared-spawn)
    setImmediate(() => {
      this.executeResumeSession(newTaskId, existingThreadId, message, options).catch((err) => {
        console.error(`[codex-adapter] Resume session failed for task ${newTaskId}:`, err);
        const current = taskManager.getTask(newTaskId);
        if (current && !this.isTaskTerminal(current.status)) {
          taskManager.updateTask(newTaskId, {
            status: 'failed' as any,
            error: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
            endTime: new Date().toISOString(),
          });
        }
      });
    });

    return newTaskId;
  }

  /**
   * Execute a resume session: starts a new app-server, reconnects to the
   * existing thread via thread/resume, then runs a turn with the message.
   */
  private async executeResumeSession(
    newTaskId: string,
    existingThreadId: string,
    message: string,
    options: ProviderSpawnOptions,
  ): Promise<void> {
    const { createTaskHandle } = await import('./task-handle-impl.js');
    const handle = createTaskHandle(newTaskId);

    const abortController = new AbortController();
    handle.registerAbort(abortController);
    this.activeControllers.set(newTaskId, abortController);

    // Timeout timer
    const timeoutTimer = setTimeout(() => {
      console.error(`[codex-adapter] Resume task ${newTaskId} timed out after ${options.timeout}ms`);
      abortController.abort();
    }, options.timeout);
    timeoutTimer.unref();

    try {
      // Append mode suffix
      const { getModeSuffixPrompt } = await import('../config/mode-prompts.js');
      const suffix = getModeSuffixPrompt('autopilot');
      const finalPrompt = suffix ? `${message}\n\n${suffix}` : message;

      await this.executeSessionWithAppServer(handle, finalPrompt, abortController.signal, {
        ...options,
        taskId: newTaskId,
        resumeSessionId: existingThreadId,
      });
    } catch (err) {
      if (handle.isAlive()) {
        if (abortController.signal.aborted) {
          handle.markCancelled('Codex resume session aborted');
        } else {
          console.error(`[codex-adapter] Resume task ${newTaskId} failed:`, err);
          handle.markFailed(
            `Codex resume error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
      handle.unregisterAbort();
      this.activeControllers.delete(newTaskId);
    }
  }

  // ---------------------------------------------------------------------------
  // App-server message handlers
  // ---------------------------------------------------------------------------

  private handleAppServerNotification(
    handle: TaskHandle,
    method: string,
    params: Record<string, unknown>,
    metrics: {
      turnCount: () => number;
      incrementTurn: () => void;
      addTokens: (input: number, output: number) => void;
      trackTool: (name: string, success: boolean) => void;
    },
  ): void {
    switch (method) {
      case 'turn/started':
        metrics.incrementTurn();
        handle.writeOutput(`--- Turn ${metrics.turnCount()} ---`);
        break;

      case 'turn/completed': {
        const turn = params.turn as Record<string, unknown> | undefined;
        const status = typeof turn?.status === 'string' ? turn.status : 'unknown';
        const error = turn?.error as Record<string, unknown> | undefined;
        if (status === 'failed' && typeof error?.message === 'string') {
          handle.writeOutput(`[error] Turn failed: ${error.message}`);
        } else if (status === 'interrupted') {
          handle.writeOutputFileOnly('[codex] turn interrupted');
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const tokenUsage = params.tokenUsage as
          | { last?: { inputTokens?: number; outputTokens?: number } }
          | undefined;
        const inputTokens = tokenUsage?.last?.inputTokens || 0;
        const outputTokens = tokenUsage?.last?.outputTokens || 0;
        metrics.addTokens(inputTokens, outputTokens);
        handle.writeOutputFileOnly(`[usage] in=${inputTokens} out=${outputTokens}`);
        break;
      }

      case 'turn/failed':
        handle.writeOutput(`[error] Turn failed: ${(params.error as { message?: string })?.message || 'unknown'}`);
        break;

      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          handle.writeOutput(params.delta);
        } else if (typeof params.text === 'string') {
          handle.writeOutput(params.text);
        }
        break;

      case 'item/started': {
        const itemType = this.normalizeAppServerItemType((params.item as Record<string, unknown>)?.type as string);
        const item = params.item as Record<string, unknown>;
        switch (itemType) {
          case 'reasoning':
            handle.writeOutputFileOnly(`[reasoning] ${this.getReasoningPreview(item).slice(0, 200)}`);
            break;
          case 'commandExecution':
            handle.writeOutput(`[tool] ${item.command}`);
            break;
          case 'fileChange': {
            const changes = (item.changes || []) as Array<{ path?: string; kind?: string }>;
            for (const change of changes) {
              handle.writeOutput(`[file] ${change.path} (${change.kind})`);
            }
            break;
          }
          case 'mcpToolCall':
            handle.writeOutput(`[tool] MCP:${item.server} ${item.tool}`);
            break;
          case 'webSearch':
            handle.writeOutput(`[search] ${item.query}`);
            break;
          case 'enteredReviewMode':
          case 'exitedReviewMode':
            handle.writeOutputFileOnly(`[review] ${item.review || itemType}`);
            break;
          case 'error':
            handle.writeOutput(`[error] ${item.message}`);
            break;
        }
        break;
      }

      case 'item/completed': {
        const itemType = this.normalizeAppServerItemType((params.item as Record<string, unknown>)?.type as string);
        const item = params.item as Record<string, unknown>;
        switch (itemType) {
          case 'commandExecution': {
            const exit = (item.exitCode as number) ?? (item.exit_code as number) ?? -1;
            const status = item.status as string;
            metrics.trackTool('commandExecution', status === 'completed');
            handle.writeOutput(`[tool] command exit=${exit} (${status})`);
            break;
          }
          case 'fileChange': {
            const changes = (item.changes || []) as unknown[];
            metrics.trackTool('fileChange', item.status === 'completed');
            handle.writeOutput(`[file] ${changes.length} changes ${item.status}`);
            break;
          }
          case 'mcpToolCall': {
            const name = `mcp:${item.server}:${item.tool}`;
            metrics.trackTool(name, item.status === 'completed');
            handle.writeOutput(`[tool] MCP:${item.server} ${item.tool} ${item.status}`);
            break;
          }
        }
        break;
      }

      // --- New notification types from the full protocol ---

      case 'turn/diff/updated':
        handle.writeOutputFileOnly(
          `[diff] ${typeof params.diff === 'string' ? params.diff.slice(0, 200) : 'updated'}`,
        );
        break;

      case 'turn/plan/updated':
        handle.writeOutputFileOnly(`[plan] ${JSON.stringify(params.plan || params).slice(0, 200)}`);
        break;

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/delta':
        if (typeof params.delta === 'string') {
          handle.writeOutputFileOnly(`[reasoning] ${params.delta}`);
        } else if (typeof params.text === 'string') {
          handle.writeOutputFileOnly(`[reasoning] ${params.text}`);
        }
        break;

      case 'item/commandExecution/outputDelta':
        if (typeof params.delta === 'string') {
          handle.writeOutput(`[cmd] ${params.delta}`);
        } else if (typeof params.output === 'string') {
          handle.writeOutput(`[cmd] ${params.output}`);
        }
        break;

      case 'thread/status/changed':
        handle.writeOutputFileOnly(`[status] Thread status: ${this.formatThreadStatus(params.status)}`);
        break;

      case 'serverRequest/resolved':
        // Acknowledgment that a server request was resolved — no action needed
        handle.writeOutputFileOnly(`[codex] serverRequest resolved: ${params.requestId || 'unknown'}`);
        break;

      case 'error':
        handle.writeOutput(
          `[error] ${String(params.message || (params.error as { message?: string } | undefined)?.message || 'unknown error')}`,
        );
        break;

      default:
        handle.writeOutputFileOnly(`[codex] notification: ${method}`);
        break;
    }
  }

  /**
   * Handle server requests from the app-server. The key one is
   * `item/tool/requestUserInput` which routes through QuestionRegistry.
   *
   * Approval requests use `{ decision: 'accept' }` per the v2 protocol.
   */
  private async handleAppServerRequest(
    handle: TaskHandle,
    client: CodexAppServerClient,
    requestId: string | number,
    method: string,
    params: Record<string, unknown>,
    taskId: string,
    questionRegistry: typeof import('../services/question-registry.js')['questionRegistry'],
    questionState: { setQuestionPending: (v: boolean) => void },
  ): Promise<void> {
    switch (method) {
      case 'item/tool/requestUserInput': {
        const uiParams = params as unknown as UserInputRequestParams;
        const questions = Array.isArray(uiParams.questions) ? uiParams.questions : [];
        const firstQuestion = questions[0];
        if (!firstQuestion) {
          // No questions — respond with empty answers
          client.respondToRequest(requestId, { answers: {} });
          break;
        }

        const multiQuestion = questions.length > 1;
        const displayedQuestion = multiQuestion
          ? this.buildCombinedUserInputQuestion(questions)
          : firstQuestion.question;
        handle.writeOutput(`[question] Codex is asking: ${displayedQuestion}`);

        const choices = multiQuestion ? undefined : firstQuestion.options?.map(o => o.label);
        const allowFreeform = multiQuestion ? true : firstQuestion.isOther !== false;

        questionState.setQuestionPending(true);
        try {
          const response = await questionRegistry.register(
            taskId,
            uiParams.threadId || '',
            displayedQuestion,
            choices,
            allowFreeform,
            'Codex',
          );
          questionState.setQuestionPending(false);

          const answers = this.buildUserInputAnswers(questions, response.answer);

          client.respondToRequest(requestId, { answers });
        } catch (err) {
          questionState.setQuestionPending(false);
          // Question timed out or was rejected — respond with error
          console.error(`[codex-adapter] User input failed for task ${taskId}:`, err);
          client.respondToRequest(requestId, { answers: {} });
        }
        break;
      }

      // v2 protocol approval flow — respond with { decision: 'accept' }
      case 'item/commandExecution/requestApproval': {
        const command = params.command || params.cmd || '(unknown)';
        handle.writeOutput(`[approval] Auto-approving command: ${String(command).slice(0, 100)}`);
        client.respondToRequest(requestId, { decision: 'accept' });
        break;
      }

      case 'item/fileChange/requestApproval': {
        const path = params.path || '(unknown)';
        handle.writeOutput(`[approval] Auto-approving file change: ${path}`);
        client.respondToRequest(requestId, { decision: 'accept' });
        break;
      }

      // Deprecated review approval flow — respond with { decision: 'approved' }
      case 'execCommandApproval': {
        const command = params.command || params.cmd || '(unknown)';
        handle.writeOutputFileOnly(`[approval] Auto-approving legacy command review: ${String(command).slice(0, 100)}`);
        client.respondToRequest(requestId, { decision: 'approved' });
        break;
      }

      case 'applyPatchApproval': {
        const path = params.path || params.filePath || '(unknown)';
        handle.writeOutputFileOnly(`[approval] Auto-approving legacy patch review: ${String(path).slice(0, 100)}`);
        client.respondToRequest(requestId, { decision: 'approved' });
        break;
      }

      // Legacy approval format (kept for backward compat)
      case 'item/tool/requestCommand':
      case 'item/tool/requestFileChange':
        handle.writeOutputFileOnly(`[approval] Auto-approving: ${method}`);
        client.respondToRequest(requestId, { decision: 'accept' });
        break;

      case 'item/tool/call': {
        const toolName = String(params.name || params.tool || 'unknown');
        console.error(
          `[codex-adapter] item/tool/call unsupported for task ${taskId}: ${toolName}`,
        );
        handle.writeOutputFileOnly(`[codex] Unsupported dynamic tool call: ${toolName}`);
        client.respondToRequest(requestId, {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: `Dynamic tool call is not supported by this client: ${toolName}`,
            },
          ],
        });
        break;
      }

      case 'account/chatgptAuthTokens/refresh': {
        const previousAccountId = typeof params.previousAccountId === 'string'
          ? params.previousAccountId
          : 'unsupported';
        console.error(
          `[codex-adapter] account/chatgptAuthTokens/refresh unsupported for task ${taskId}; responding with empty token payload`,
        );
        handle.writeOutputFileOnly('[codex] ChatGPT auth token refresh unsupported by adapter');
        client.respondToRequest(requestId, {
          accessToken: '',
          chatgptAccountId: previousAccountId,
          chatgptPlanType: null,
        });
        break;
      }

      // MCP server elicitation — respond with empty result
      case 'mcpServer/elicitation/request':
        handle.writeOutputFileOnly('[codex] MCP elicitation request unsupported — cancelling');
        client.respondToRequest(requestId, { action: 'cancel', content: null });
        break;

      default:
        console.error(`[codex-adapter] Unknown server request: ${method}`);
        client.respondToRequest(requestId, {});
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Abort — try turn/interrupt before process kill
  // ---------------------------------------------------------------------------

  async abort(taskId: string, _reason?: string): Promise<boolean> {
    console.error(
      `[codex-adapter] Abort: task=${taskId}, reason=${_reason || 'none'}, ` +
      `hasClient=${this.activeClients.has(taskId)}, hasController=${this.activeControllers.has(taskId)}`,
    );

    const { questionRegistry } = await import('../services/question-registry.js');

    // Clear any pending question immediately
    if (questionRegistry.hasPendingQuestion(taskId)) {
      console.error(`[codex-adapter] Abort: clearing pending question for task ${taskId}`);
      questionRegistry.clearQuestion(taskId, 'task aborted');
    }

    // Try graceful turn/interrupt via the client first
    const client = this.activeClients.get(taskId);
    if (client && !client.isDestroyed) {
      console.error(`[codex-adapter] Abort: sending turn/interrupt for task ${taskId}`);
      const interrupted = await client.interruptTurn();
      if (interrupted) {
        console.error(`[codex-adapter] Abort: turn/interrupt acknowledged for task ${taskId}`);
        // Give the process a moment to wrap up after interrupt
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 2_000);
          t.unref();
        });
      }

      // Destroy the client (kills process if still alive)
      client.destroy();
      this.activeClients.delete(taskId);
    }

    // Fall back to abort controller
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      console.error(`[codex-adapter] Abort: using abort controller for task ${taskId}`);
      controller.abort();
      return true;
    }

    // Fall back to processRegistry kill escalation
    console.error(`[codex-adapter] Abort: falling back to processRegistry kill for task ${taskId}`);
    const { processRegistry } = await import('../services/process-registry.js');
    return processRegistry.killTask(taskId);
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    // Destroy all active clients (kills processes)
    for (const [taskId, client] of this.activeClients) {
      console.error(`[codex-adapter] Shutting down client for task ${taskId}`);
      try { client.destroy(); } catch { /* swallow */ }
    }
    this.activeClients.clear();

    // Abort remaining controllers
    for (const [taskId, controller] of this.activeControllers) {
      console.error(`[codex-adapter] Aborting controller for task ${taskId}`);
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
      cliAuthConfigured: HAS_CLI_AUTH,
      model: CODEX_MODEL,
      sandboxMode: CODEX_SANDBOX_MODE,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      disabled: process.env.DISABLE_CODEX_FALLBACK === 'true',
      appServerMode: USE_APP_SERVER,
      forceSdkMode: FORCE_SDK_MODE,
      activeClients: this.activeClients.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isTaskTerminal(status: string): boolean {
    return ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);
  }

  private normalizeAppServerItemType(itemType: string | undefined): string {
    switch (itemType) {
      case 'command_execution':
        return 'commandExecution';
      case 'file_change':
        return 'fileChange';
      case 'mcp_tool_call':
        return 'mcpToolCall';
      case 'web_search':
        return 'webSearch';
      case 'agent_message':
        return 'agentMessage';
      default:
        return itemType || '';
    }
  }

  private getReasoningPreview(item: Record<string, unknown>): string {
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string') : [];
    if (summary.length > 0) return summary.join(' ');

    const content = Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === 'string') : [];
    if (content.length > 0) return content.join(' ');

    if (typeof item.text === 'string') return item.text;
    return '';
  }

  private buildCombinedUserInputQuestion(questions: UserInputRequestParams['questions']): string {
    const lines = [
      'Codex asked multiple questions. Answer with one line per question, in order.',
      '',
    ];

    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${question.question}`);
      const options = question.options?.map((option, optionIndex) =>
        `   ${String.fromCharCode(97 + optionIndex)}) ${option.label}${option.description ? ` — ${option.description}` : ''}`,
      );
      if (options && options.length > 0) {
        lines.push(...options);
      }
      lines.push('');
    });

    return lines.join('\n').trim();
  }

  private buildUserInputAnswers(
    questions: UserInputRequestParams['questions'],
    responseText: string,
  ): Record<string, { answers: string[] }> {
    const trimmed = responseText.trim();
    const splitLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+[\).\s:-]*/, '').trim())
      .filter(Boolean);

    const normalizedAnswers = splitLines.length === 0
      ? [trimmed]
      : splitLines.length === 1
        ? Array.from({ length: questions.length }, () => splitLines[0])
        : [
            ...splitLines.slice(0, questions.length),
            ...Array.from(
              { length: Math.max(0, questions.length - splitLines.length) },
              () => splitLines[splitLines.length - 1],
            ),
          ].slice(0, questions.length);

    return Object.fromEntries(
      questions.map((question, index) => [question.id, { answers: [normalizedAnswers[index] || trimmed] }]),
    );
  }

  private formatThreadStatus(status: unknown): string {
    if (typeof status === 'string' && status.trim()) {
      return status;
    }

    if (status && typeof status === 'object') {
      try {
        return JSON.stringify(status).slice(0, 160);
      } catch {
        return '[unserializable status]';
      }
    }

    return 'unknown';
  }
}
