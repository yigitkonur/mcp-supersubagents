/**
 * Claude Code Fallback Runner (ai-sdk-provider-claude-code)
 *
 * Executes fallback tasks through the ben-vargas provider, which wraps
 * @anthropic-ai/claude-agent-sdk with richer streaming, metadata, and errors.
 */

import { claudeCode, isAuthenticationError, isTimeoutError, type PermissionResult } from 'ai-sdk-provider-claude-code';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { taskManager } from './task-manager.js';
import { processRegistry } from './process-registry.js';
import { TaskStatus, ToolMetrics, isTerminalStatus, type FallbackReason } from '../types.js';

const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_MODEL = 'sonnet';
const DEFAULT_PERMISSION_MODE = process.env.CLAUDE_FALLBACK_PERMISSION_MODE || 'plan';
const TOOL_POLICY_MODE = process.env.CLAUDE_FALLBACK_TOOL_POLICY || 'allow_all';
const DEBUG = process.env.DEBUG_CLAUDE_FALLBACK === 'true';
const activeFallbackControllers = new Map<string, AbortController>();

const MAX_CONCURRENT_FALLBACKS = parseInt(process.env.MAX_CONCURRENT_CLAUDE_FALLBACKS || '3', 10);
let activeFallbackCount = 0;
const fallbackQueue: Array<() => void> = [];

// FB-014: Pre-flight check for Claude provider availability
let claudeAvailabilityChecked = false;
let claudeAvailable = true;

async function checkClaudeAvailability(): Promise<boolean> {
  if (claudeAvailabilityChecked) return claudeAvailable;
  try {
    if (typeof claudeCode !== 'function') {
      throw new Error('claudeCode provider is not a function');
    }
    claudeAvailabilityChecked = true;
    claudeAvailable = true;
    return true;
  } catch {
    claudeAvailabilityChecked = true;
    claudeAvailable = false;
    console.error('[claude-code-runner] Claude Agent SDK provider not available — fallback will be disabled');
    return false;
  }
}

function acquireFallbackSlot(): Promise<void> {
  if (activeFallbackCount < MAX_CONCURRENT_FALLBACKS) {
    activeFallbackCount++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    fallbackQueue.push(resolve);
  });
}

function releaseFallbackSlot(): void {
  activeFallbackCount--;
  const next = fallbackQueue.shift();
  if (next) {
    activeFallbackCount++;
    next();
  }
}

export interface ClaudeCodeRunOptions {
  resumeSessionId?: string;
  fallbackReason?: FallbackReason;
  preferredModel?: string;
}

function normalizeClaudeModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;

  const normalized = model.toLowerCase();
  if (normalized.includes('opus') || normalized === 'claude-opus-4.6') return 'opus';
  if (normalized.includes('haiku') || normalized === 'claude-haiku-4.5') return 'haiku';
  if (normalized.includes('sonnet') || normalized === 'claude-sonnet-4.5') return 'sonnet';

  return model;
}

function resolveFallbackModel(preferredModel?: string): string {
  const envOverride = process.env.CLAUDE_FALLBACK_MODEL?.trim();
  if (envOverride) return normalizeClaudeModel(envOverride);
  return normalizeClaudeModel(preferredModel);
}

function parseCsvEnv(name: string): string[] | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function parseBudget(): number | undefined {
  const raw = process.env.CLAUDE_FALLBACK_MAX_BUDGET_USD;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function extractToolCommand(input: Record<string, unknown>): string {
  const candidates = ['command', 'cmd', 'input', 'value'];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

async function canUseToolSafePolicy(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string
): Promise<PermissionResult> {
  if (TOOL_POLICY_MODE !== 'safe') {
    return { behavior: 'allow', toolUseID };
  }

  if (toolName === 'Bash') {
    const cmd = extractToolCommand(input).toLowerCase();
    const dangerousPatterns = [
      /\brm\s+-rf\s+\//,
      /\bmkfs\b/,
      /\bdd\s+if=/,
      /\bshutdown\b/,
      /\breboot\b/,
      /\bchown\s+-r\s+root\b/,
    ];

    if (dangerousPatterns.some((re) => re.test(cmd))) {
      return {
        behavior: 'deny',
        message: `Denied by safe policy: dangerous command (${cmd})`,
        toolUseID,
      };
    }
  }

  return { behavior: 'allow', toolUseID };
}

function createModelSettings(cwd: string, options: ClaudeCodeRunOptions): Record<string, unknown> {
  const allowedTools = parseCsvEnv('CLAUDE_FALLBACK_ALLOWED_TOOLS') ?? ['*'];
  const disallowedTools = parseCsvEnv('CLAUDE_FALLBACK_DISALLOWED_TOOLS');
  const maxBudgetUsd = parseBudget();

  const settings: Record<string, unknown> = {
    cwd,
    permissionMode: DEFAULT_PERMISSION_MODE,
    allowedTools: disallowedTools ? undefined : allowedTools,
    disallowedTools,
    maxBudgetUsd,
    streamingInput: 'always',
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { toolUseID: string }
    ): Promise<PermissionResult> => {
      return canUseToolSafePolicy(toolName, input, ctx.toolUseID);
    },
    resume: options.resumeSessionId,
    verbose: process.env.DEBUG_CLAUDE_FALLBACK === 'true',
  };

  return settings;
}

function createPrompt(prompt: string): LanguageModelV3Message[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  ];
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseRunOptions(optionsOrResume?: string | ClaudeCodeRunOptions): ClaudeCodeRunOptions {
  if (typeof optionsOrResume === 'string') {
    return { resumeSessionId: optionsOrResume };
  }
  return optionsOrResume ?? {};
}

export function abortClaudeCodeSession(taskId: string, reason: string = 'Task cancelled by user'): boolean {
  const controller = activeFallbackControllers.get(taskId);
  if (!controller) {
    return false;
  }
  controller.abort(new Error(reason));
  return true;
}

export async function runClaudeCodeSession(
  taskId: string,
  prompt: string,
  cwd: string,
  timeout: number,
  optionsOrResume?: string | ClaudeCodeRunOptions
): Promise<void> {
  const options = parseRunOptions(optionsOrResume);
  const task = taskManager.getTask(taskId);
  if (!task) {
    console.error(`[claude-code-runner] Task ${taskId} not found`);
    return;
  }

  if (isTerminalStatus(task.status)) {
    console.error(`[claude-code-runner] Task ${taskId} already terminal (${task.status}), skipping`);
    return;
  }

  // FB-014: Pre-flight check — fail fast if provider is unavailable
  if (!(await checkClaudeAvailability())) {
    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      endTime: nowIso(),
      error: 'Claude Agent SDK provider is not available',
      exitCode: 1,
      failureContext: {
        errorType: 'claude_unavailable',
        message: 'Claude Agent SDK provider (ai-sdk-provider-claude-code) could not be loaded',
        recoverable: false,
      },
      session: undefined,
    });
    return;
  }

  const existingController = activeFallbackControllers.get(taskId);
  if (existingController) {
    console.error(`[claude-code-runner] Task ${taskId} has existing fallback run, aborting it before retry`);
    try { existingController.abort(new Error('Superseded by retry')); } catch { /* ignore */ }
    activeFallbackControllers.delete(taskId);
    processRegistry.unregister(taskId);
  }

  // Wait for available slot (limits concurrent Claude processes)
  await acquireFallbackSlot();

  // Re-check task status after potentially waiting for slot
  const freshCheck = taskManager.getTask(taskId);
  if (!freshCheck || isTerminalStatus(freshCheck.status)) {
    releaseFallbackSlot();
    return;
  }

  const effectiveTimeout = timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
  const fallbackReason = options.fallbackReason ?? 'copilot_accounts_exhausted';
  const modelId = resolveFallbackModel(options.preferredModel ?? task.model);

  taskManager.updateTask(taskId, {
    status: TaskStatus.RUNNING,
    provider: 'claude-cli',
    sessionMetrics: {
      ...task.sessionMetrics,
      quotas: task.sessionMetrics?.quotas || {},
      toolMetrics: task.sessionMetrics?.toolMetrics || {},
      activeSubagents: [],
      completedSubagents: [],
      turnCount: 0,
      totalTokens: { input: 0, output: 0 },
      provider: 'claude-cli',
      fallbackActivated: true,
      fallbackReason,
    },
  });

  const abortController = new AbortController();
  activeFallbackControllers.set(taskId, abortController);
  processRegistry.register({
    taskId,
    abortController,
    registeredAt: Date.now(),
    label: 'claude-fallback',
  });
  const timeoutHandle = setTimeout(() => {
    abortController.abort(new Error(`Claude fallback timed out after ${effectiveTimeout}ms`));
  }, effectiveTimeout);

  const toolMetrics: Record<string, ToolMetrics> = {};
  const toolStartTimes = new Map<string, number>();

  let turnCount = 0;
  let sessionId: string | undefined = options.resumeSessionId;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let providerCostUsd: number | undefined;
  let providerDurationMs: number | undefined;
  let resultError: string | undefined;
  let inTextBlock = false; // Track whether we're inside a text content block

  const settings = createModelSettings(cwd, options);
  let reader: any;

  try {
    const model = claudeCode(modelId as any, settings as any) as LanguageModelV3;

    const callOptions: LanguageModelV3CallOptions = {
      prompt: createPrompt(prompt),
      abortSignal: abortController.signal,
      providerOptions: {},
      responseFormat: { type: 'text' },
    };

    const streamResult = await model.doStream(callOptions);
    reader = streamResult.stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const part = value as LanguageModelV3StreamPart | ({ type: string; [k: string]: unknown } & Record<string, unknown>);

      if (DEBUG) {
        console.error(`[claude-code-runner] Stream part: ${part.type}`);
      }

      switch (part.type) {
        case 'text-start':
          // text-start is a content block boundary, not a turn boundary.
          // Only emit a turn marker if this is the first text block or
          // a new text block after a tool execution (i.e., a new agent turn).
          if (!inTextBlock) {
            turnCount += 1;
            taskManager.appendOutput(taskId, `\n[Assistant Turn ${turnCount}]\n`);
          }
          inTextBlock = true;
          break;

        case 'text-delta':
          taskManager.appendOutput(taskId, String((part as any).delta));
          break;

        case 'text-end':
          inTextBlock = false;
          break;

        case 'reasoning-start':
          break;

        case 'reasoning-delta':
          // Reasoning → file only (saves tokens for caller)
          taskManager.appendOutputFileOnly(taskId, `[reasoning] ${part.delta}`);
          break;

        case 'reasoning-end':
          break;

        // V3 tool-input-* events: emitted by ai-sdk-provider-claude-code BEFORE tool-call
        case 'tool-input-start': {
          inTextBlock = false; // Tool execution ends the current text block
          const inputToolName = (part as Record<string, unknown>).toolName as string || 'unknown';
          const inputToolId = (part as Record<string, unknown>).id as string || '';
          if (!toolMetrics[inputToolName]) {
            toolMetrics[inputToolName] = {
              toolName: inputToolName,
              executionCount: 0,
              successCount: 0,
              failureCount: 0,
              totalDurationMs: 0,
            };
          }
          toolMetrics[inputToolName].executionCount += 1;
          toolStartTimes.set(inputToolId, Date.now());
          taskManager.appendOutput(taskId, `[tool] Starting: ${inputToolName}`);
          break;
        }

        case 'tool-input-delta':
          // Tool input streaming — log in debug mode only to avoid noise
          if (DEBUG) {
            const delta = (part as Record<string, unknown>).delta as string || '';
            if (delta.length > 0) {
              taskManager.appendOutput(taskId, `[tool-input] ${delta.slice(0, 200)}`);
            }
          }
          break;

        case 'tool-input-end':
          break;

        case 'tool-call': {
          const toolName = (part as any).toolName || 'unknown';
          // Only create metrics if tool-input-start didn't already (backward compat)
          if (!toolMetrics[toolName]) {
            toolMetrics[toolName] = {
              toolName,
              executionCount: 0,
              successCount: 0,
              failureCount: 0,
              totalDurationMs: 0,
            };
          }
          // Only increment if tool-input-start didn't already track this call
          if (!toolStartTimes.has((part as any).toolCallId)) {
            toolMetrics[toolName].executionCount += 1;
            toolStartTimes.set((part as any).toolCallId, Date.now());
            taskManager.appendOutput(taskId, `[tool] Starting: ${toolName}`);
          }
          break;
        }

        case 'tool-result': {
          const toolName = (part as any).toolName || 'unknown';
          const start = toolStartTimes.get((part as any).toolCallId);
          const duration = start ? Date.now() - start : 0;
          toolStartTimes.delete((part as any).toolCallId);

          const metrics = toolMetrics[toolName] || {
            toolName,
            executionCount: 0,
            successCount: 0,
            failureCount: 0,
            totalDurationMs: 0,
          };

          metrics.totalDurationMs += duration;
          metrics.lastExecutedAt = nowIso();
          if ((part as any).isError) {
            metrics.failureCount += 1;
            taskManager.appendOutput(taskId, `[tool] Failed: ${toolName}`);
          } else {
            metrics.successCount += 1;
            taskManager.appendOutput(taskId, `[tool] Completed: ${toolName} (${duration}ms)`);
          }
          toolMetrics[toolName] = metrics;
          break;
        }

        case 'finish': {
          totalInputTokens = (part as any).usage?.inputTokens?.total ?? totalInputTokens;
          totalOutputTokens = (part as any).usage?.outputTokens?.total ?? totalOutputTokens;

          const ccMeta = (part as any).providerMetadata?.['claude-code'] as Record<string, unknown> | undefined;
          if (ccMeta) {
            const maybeSession = ccMeta['sessionId'];
            const maybeCost = ccMeta['costUsd'];
            const maybeDuration = ccMeta['durationMs'];
            if (typeof maybeSession === 'string') sessionId = maybeSession;
            if (typeof maybeCost === 'number') providerCostUsd = maybeCost;
            if (typeof maybeDuration === 'number') providerDurationMs = maybeDuration;
          }

          if ((part as any).finishReason?.unified === 'error' && !resultError) {
            resultError = `Claude stream ended with error (${(part as any).finishReason?.raw ?? 'unknown'})`;
          }
          break;
        }

        case 'error':
          resultError = String((part as any).error ?? 'unknown stream error');
          taskManager.appendOutput(taskId, `[error] ${resultError}`);
          break;

        case 'stream-start':
          if ((part as any).warnings?.length > 0) {
            taskManager.appendOutput(taskId, `[system] Claude warnings: ${((part as any).warnings || []).map((w: { type: string }) => w.type).join(', ')}`);
          }
          break;

        case 'source':
          if (DEBUG) {
            taskManager.appendOutput(taskId, `[source] ${JSON.stringify((part as Record<string, unknown>).source ?? '')}`);
          }
          break;

        case 'file':
          if (DEBUG) {
            const filePart = part as Record<string, unknown>;
            taskManager.appendOutput(taskId, `[file] ${filePart.mimeType ?? 'unknown'}`);
          }
          break;

        case 'tool-approval-request':
          // Auto-approve: the server runs in bypass-permissions mode
          console.error(`[claude-code-runner] Received tool-approval-request for task ${taskId} (auto-approve mode — no action needed)`);
          break;

        default:
          if ((part as { type?: string }).type === 'tool-error') {
            const toolName = String((part as Record<string, unknown>).toolName ?? 'unknown');
            const toolCallId = String((part as Record<string, unknown>).toolCallId ?? '');
            const err = String((part as Record<string, unknown>).error ?? 'Tool error');
            const start = toolCallId ? toolStartTimes.get(toolCallId) : undefined;
            const duration = start ? Date.now() - start : 0;

            const metrics = toolMetrics[toolName] || {
              toolName,
              executionCount: 0,
              successCount: 0,
              failureCount: 0,
              totalDurationMs: 0,
            };
            metrics.failureCount += 1;
            metrics.totalDurationMs += duration;
            metrics.lastExecutedAt = nowIso();
            toolMetrics[toolName] = metrics;

            taskManager.appendOutput(taskId, `[tool] Failed: ${toolName} - ${err}`);
          } else if (DEBUG) {
            console.error(`[claude-code-runner] Unhandled stream part type: ${(part as { type?: string }).type}`);
          }
          break;
      }
    }

    const freshTask = taskManager.getTask(taskId);
    if (!freshTask || isTerminalStatus(freshTask.status)) {
      return;
    }

    const sessionMetrics = {
      quotas: {},
      toolMetrics,
      activeSubagents: [],
      completedSubagents: [],
      turnCount,
      totalTokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
      },
      provider: 'claude-cli' as const,
      fallbackActivated: true,
      fallbackReason,
      sdkMetrics: {
        totalPremiumRequests: 0,
        totalApiDurationMs: providerDurationMs ?? 0,
      },
    };

    if (providerCostUsd !== undefined) {
      taskManager.appendOutput(taskId, `[metrics] Claude fallback cost: $${providerCostUsd.toFixed(4)}`);
    }

    if (resultError) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        endTime: nowIso(),
        exitCode: 1,
        error: resultError,
        failureContext: {
          errorType: 'claude_provider_error',
          message: resultError,
          recoverable: false,
        },
        sessionMetrics,
        sessionId,
        session: undefined,
      });
      return;
    }

    // Emit compact summary before marking completed
    const elapsedMs = Date.now() - (task?.startTime ? new Date(task.startTime).getTime() : Date.now());
    const toolCallCount = Object.values(toolMetrics).reduce((s, m) => s + (m.executionCount || 0), 0);
    const totalTokens = totalInputTokens + totalOutputTokens;
    taskManager.appendOutput(
      taskId,
      `[summary] ${turnCount} turns | ${toolCallCount} tool calls | ${Math.round(totalTokens / 1000)}K tokens | ${Math.round(elapsedMs / 1000)}s`
    );

    taskManager.updateTask(taskId, {
      status: TaskStatus.COMPLETED,
      endTime: nowIso(),
      exitCode: 0,
      sessionMetrics,
      sessionId,
      session: undefined,
    });
  } catch (error: unknown) {
    const freshTask = taskManager.getTask(taskId);
    if (!freshTask || isTerminalStatus(freshTask.status)) {
      return;
    }

    if (abortController.signal.aborted) {
      const reason = String(abortController.signal.reason ?? '');
      if (reason.toLowerCase().includes('cancel')) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.CANCELLED,
          endTime: nowIso(),
          error: reason || 'Task cancelled',
          exitCode: 130,
          session: undefined,
        });
      } else {
        taskManager.updateTask(taskId, {
          status: TaskStatus.TIMED_OUT,
          endTime: nowIso(),
          error: `Task timed out after ${effectiveTimeout}ms`,
          timeoutReason: 'hard_timeout',
          exitCode: 124,
          session: undefined,
        });
      }
      return;
    }

    let errorMessage = error instanceof Error ? error.message : String(error);
    if (isAuthenticationError(error)) {
      errorMessage = `Claude Code authentication failed: ${errorMessage}`;
    } else if (isTimeoutError(error)) {
      errorMessage = `Claude Code timed out: ${errorMessage}`;
    }

    taskManager.updateTask(taskId, {
      status: TaskStatus.FAILED,
      endTime: nowIso(),
      error: errorMessage,
      exitCode: 1,
      failureContext: {
        errorType: error instanceof Error ? error.name : 'unknown',
        message: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        recoverable: false,
      },
      session: undefined,
    });
  } finally {
    clearTimeout(timeoutHandle);
    const ctrl = activeFallbackControllers.get(taskId);
    if (ctrl === abortController) {
      activeFallbackControllers.delete(taskId);
    }
    processRegistry.unregister(taskId);
    releaseFallbackSlot();
    // Ensure abort signal is sent even if we got here via unexpected path
    if (!abortController.signal.aborted) {
      try { abortController.abort(new Error('Session ended')); } catch { /* ignore */ }
    }
    try { reader?.cancel(); } catch {}
    for (const key in toolMetrics) delete toolMetrics[key];
    toolStartTimes.clear();
  }
}

/**
 * Abort all active Claude CLI fallback sessions.
 * Called during server shutdown.
 */
export function abortAllFallbackSessions(reason: string = 'Server shutdown'): number {
  let aborted = 0;
  for (const [taskId, controller] of activeFallbackControllers) {
    console.error(`[claude-code-runner] Shutdown: aborting fallback for task ${taskId}`);
    try {
      controller.abort(new Error(reason));
      aborted += 1;
    } catch (error) {
      console.error(`[claude-code-runner] Failed to abort fallback for task ${taskId}:`, error);
    }
    processRegistry.unregister(taskId);
  }
  activeFallbackControllers.clear();

  // FB-013: Drain pending queue to release slots — they'll hit terminal check in runClaudeCodeSession
  while (fallbackQueue.length > 0) {
    const resolver = fallbackQueue.shift();
    if (resolver) resolver();
  }

  return aborted;
}
