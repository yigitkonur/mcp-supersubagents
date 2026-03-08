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
import { TaskStatus, ToolMetrics, isTerminalStatus, type FallbackReason, type AgentMode } from '../types.js';
import { getModeSuffixPrompt } from '../config/mode-prompts.js';
import { extractToolContext, extractResultInfo, formatToolComplete, type ToolCallContext } from '../utils/tool-summarizer.js';

const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_MODEL = 'sonnet';
const DEFAULT_PERMISSION_MODE = process.env.CLAUDE_FALLBACK_PERMISSION_MODE || 'bypassPermissions';
const TOOL_POLICY_MODE = process.env.CLAUDE_FALLBACK_TOOL_POLICY || 'allow_all';
const DEBUG = process.env.DEBUG_CLAUDE_FALLBACK === 'true';
const activeFallbackControllers = new Map<string, AbortController>();

const parsedMaxFallbacks = parseInt(process.env.MAX_CONCURRENT_CLAUDE_FALLBACKS || '3', 10);
const MAX_CONCURRENT_FALLBACKS = Number.isFinite(parsedMaxFallbacks) && parsedMaxFallbacks > 0 ? parsedMaxFallbacks : 3;

const parsedMaxTurns = parseInt(process.env.CLAUDE_FALLBACK_MAX_TURNS || '100', 10);
const MAX_TURNS = Number.isFinite(parsedMaxTurns) && parsedMaxTurns >= 1 && parsedMaxTurns <= 100 ? parsedMaxTurns : 100;
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
  if (normalized.includes('sonnet') || normalized === 'claude-sonnet-4.6') return 'sonnet';

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

/**
 * Combine multiple questions into a single display string for the question registry.
 * Mirrors Codex adapter's buildCombinedUserInputQuestion pattern.
 */
function buildCombinedQuestionText(questions: Record<string, unknown>[]): string {
  const lines = [
    'The agent asked multiple questions. Answer with one line per question, in order.',
    '',
  ];

  questions.forEach((q, index) => {
    lines.push(`${index + 1}. ${q.question}`);
    const opts = Array.isArray(q.options) ? q.options as unknown[] : [];
    const optLines = opts
      .map((o, oi) => {
        if (!o || typeof o !== 'object' || !('label' in o)) return '';
        const label = String((o as { label: string }).label);
        const desc = 'description' in o && typeof (o as { description?: string }).description === 'string'
          ? ` — ${(o as { description: string }).description}` : '';
        return `   ${String.fromCharCode(97 + oi)}) ${label}${desc}`;
      })
      .filter(Boolean);
    if (optLines.length > 0) lines.push(...optLines);
    lines.push('');
  });

  return lines.join('\n').trim();
}

/**
 * Handle AskUserQuestion tool calls from Claude sub-agents by routing them
 * through the question registry. Returns a 'deny' PermissionResult with the
 * user's answer in the message — the model sees it and proceeds accordingly.
 */
async function handleAskUserQuestion(
  taskId: string,
  input: Record<string, unknown>,
  toolUseID: string,
): Promise<PermissionResult> {
  // Lazy import to avoid circular deps
  const { questionRegistry } = await import('./question-registry.js');

  try {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const validQuestions = questions.filter(
      (q): q is Record<string, unknown> => !!q && typeof (q as Record<string, unknown>).question === 'string',
    );

    if (validQuestions.length === 0) {
      return {
        behavior: 'deny',
        message: 'No valid question provided. Proceed with your best judgment and document your assumptions.',
        toolUseID,
      };
    }

    // Build display question and choices — single question uses direct text,
    // multi-question combines into a numbered list (same pattern as Codex adapter)
    const multiQuestion = validQuestions.length > 1;
    let displayQuestion: string;
    let flatChoices: string[] | undefined;

    if (multiQuestion) {
      displayQuestion = buildCombinedQuestionText(validQuestions);
      flatChoices = undefined; // freeform only for multi-question
    } else {
      const q = validQuestions[0];
      displayQuestion = q.question as string;
      const opts = Array.isArray(q.options) ? q.options as unknown[] : [];
      flatChoices = opts
        .map((o) => (o && typeof o === 'object' && 'label' in o) ? String((o as { label: string }).label) : '')
        .filter(Boolean);
      if (flatChoices.length === 0) flatChoices = undefined;
    }

    // Log all questions to output
    for (const q of validQuestions) {
      const qText = (q.question as string).slice(0, 200);
      taskManager.appendOutput(taskId, `[question] Agent asked: "${qText}"`);
      const opts = Array.isArray(q.options) ? q.options as unknown[] : [];
      const labels = opts
        .map((o) => (o && typeof o === 'object' && 'label' in o) ? String((o as { label: string }).label) : '')
        .filter(Boolean);
      if (labels.length > 0) {
        taskManager.appendOutput(taskId, `[question] Options: ${labels.join(' | ')}`);
      }
    }

    // Single registry call — blocks until orchestrator answers via answer-agent
    const response = await questionRegistry.register(
      taskId,
      '',             // no session ID for Claude
      displayQuestion,
      flatChoices,
      true,           // allowFreeform
      'Claude',
    );

    const answer = response.kind === 'structured'
      ? Object.values(response.answers).map(a => a.answers.join(', ')).join('; ')
      : response.answer;

    taskManager.appendOutput(taskId, `[question] User answered: "${answer.slice(0, 200)}"`);

    // Truncate and sanitize answer for the deny message (full answer already logged above)
    const MAX_DENY_ANSWER_LENGTH = 500;
    const sanitized = answer.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ').slice(0, MAX_DENY_ANSWER_LENGTH);

    return {
      behavior: 'deny',
      message: multiQuestion
        ? `User answered your questions: ${sanitized}. Proceed with these choices.`
        : `User responded to your question "${displayQuestion}": ${sanitized}. Proceed with this choice.`,
      toolUseID,
    };
  } catch (err) {
    console.error(`[claude-code-runner] handleAskUserQuestion failed for task ${taskId}:`, err);
    return {
      behavior: 'deny',
      message: 'Question routing failed. Proceed with your best judgment and document your assumptions.',
      toolUseID,
    };
  }
}

function createModelSettings(cwd: string, taskId: string, options: ClaudeCodeRunOptions): Record<string, unknown> {
  const allowedTools = parseCsvEnv('CLAUDE_FALLBACK_ALLOWED_TOOLS') ?? ['*'];
  const disallowedTools = parseCsvEnv('CLAUDE_FALLBACK_DISALLOWED_TOOLS');
  const maxBudgetUsd = parseBudget();

  const settings: Record<string, unknown> = {
    cwd,
    permissionMode: DEFAULT_PERMISSION_MODE,
    allowedTools: disallowedTools ? undefined : allowedTools,
    disallowedTools,
    maxBudgetUsd,
    maxTurns: MAX_TURNS,
    streamingInput: 'always',
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { toolUseID: string }
    ): Promise<PermissionResult> => {
      if (toolName === 'AskUserQuestion') {
        return handleAskUserQuestion(taskId, input, ctx.toolUseID);
      }
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
      providerState: undefined,
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
  const toolCallContexts = new Map<string, ToolCallContext>();

  let turnCount = 0;
  let sessionId: string | undefined = options.resumeSessionId;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let providerCostUsd: number | undefined;
  let providerDurationMs: number | undefined;
  let resultError: string | undefined;
  let inTextBlock = false; // Track whether we're inside a text content block

  // Streaming buffers: collect deltas and flush as complete lines on block boundaries
  // to avoid writing hundreds of single-word lines to the output file.
  const textBuffer: string[] = [];
  const reasoningBuffer: string[] = [];

  function flushTextBuffer(): void {
    if (textBuffer.length > 0) {
      taskManager.appendOutput(taskId, textBuffer.join(''));
      textBuffer.length = 0;
    }
  }

  function flushReasoningBuffer(): void {
    if (reasoningBuffer.length > 0) {
      taskManager.appendOutputFileOnly(taskId, `[reasoning] ${reasoningBuffer.join('')}`);
      reasoningBuffer.length = 0;
    }
  }

  const settings = createModelSettings(cwd, taskId, options);
  let reader: any;

  try {
    const model = claudeCode(modelId as any, settings as any) as LanguageModelV3;

    // Autopilot mode for Claude fallback — no suffix needed (autopilot suffix is empty)
    const effectiveMode: AgentMode = 'autopilot';
    const modeSuffix = getModeSuffixPrompt(effectiveMode);
    const effectivePrompt = modeSuffix ? prompt + modeSuffix : prompt;
    taskManager.appendOutputFileOnly(taskId, `[system] Claude fallback mode: ${effectiveMode}`);

    const callOptions: LanguageModelV3CallOptions = {
      prompt: createPrompt(effectivePrompt),
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
          // Flush any pending reasoning before starting a new text block
          flushReasoningBuffer();
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
          textBuffer.push(String((part as any).delta));
          break;

        case 'text-end':
          flushTextBuffer();
          inTextBlock = false;
          break;

        case 'reasoning-start':
          break;

        case 'reasoning-delta':
          // Reasoning → file only (saves tokens for caller)
          reasoningBuffer.push(String(part.delta));
          break;

        case 'reasoning-end':
          flushReasoningBuffer();
          break;

        // V3 tool-input-* events: emitted by ai-sdk-provider-claude-code BEFORE tool-call
        case 'tool-input-start': {
          flushTextBuffer(); // Flush any pending text before tool execution
          flushReasoningBuffer();
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
          const toolCallId = (part as any).toolCallId || '';
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
          if (!toolStartTimes.has(toolCallId)) {
            toolMetrics[toolName].executionCount += 1;
            toolStartTimes.set(toolCallId, Date.now());
            taskManager.appendOutput(taskId, `[tool] Starting: ${toolName}`);
          }
          // Parse tool args for rich completion summaries
          try {
            const rawInput = (part as any).input;
            const parsedArgs = typeof rawInput === 'string' ? JSON.parse(rawInput)
              : (rawInput && typeof rawInput === 'object') ? rawInput : undefined;
            if (parsedArgs) {
              toolCallContexts.set(toolCallId, extractToolContext(toolName, parsedArgs));
            }
          } catch { /* ignore JSON parse failures */ }
          break;
        }

        case 'tool-result': {
          const toolName = (part as any).toolName || 'unknown';
          const toolCallId = (part as any).toolCallId || '';
          const start = toolStartTimes.get(toolCallId);
          const duration = start ? Date.now() - start : 0;
          toolStartTimes.delete(toolCallId);

          const ctx = toolCallContexts.get(toolCallId);
          toolCallContexts.delete(toolCallId);

          const metrics = toolMetrics[toolName] || {
            toolName,
            executionCount: 0,
            successCount: 0,
            failureCount: 0,
            totalDurationMs: 0,
          };

          const isError = !!(part as any).isError;
          metrics.totalDurationMs += duration;
          metrics.lastExecutedAt = nowIso();

          if (isError) {
            metrics.failureCount += 1;
          } else {
            metrics.successCount += 1;
          }

          // Generate compact summary using tool context + result info
          if (ctx) {
            const resultInfo = extractResultInfo(toolName, (part as any).result);
            const summary = formatToolComplete(ctx, {
              duration,
              success: !isError,
              error: isError ? String((part as any).result ?? 'Tool error') : undefined,
              ...resultInfo,
            });
            taskManager.appendOutput(taskId, `[tool] ${summary}`);
          } else {
            // Fallback: no context saved (tool-call event was missed)
            taskManager.appendOutput(taskId,
              isError ? `[tool] Failed: ${toolName}` : `[tool] Completed: ${toolName} (${duration}ms)`);
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
          flushTextBuffer();
          flushReasoningBuffer();
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

            const ctx = toolCallId ? toolCallContexts.get(toolCallId) : undefined;
            if (toolCallId) {
              toolStartTimes.delete(toolCallId);
              toolCallContexts.delete(toolCallId);
            }

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

            const summary = ctx
              ? formatToolComplete(ctx, { duration, success: false, error: err })
              : `Failed: ${toolName} — ${err}`;
            taskManager.appendOutput(taskId, `[tool] ${summary}`);
          } else if (DEBUG) {
            console.error(`[claude-code-runner] Unhandled stream part type: ${(part as { type?: string }).type}`);
          }
          break;
      }
    }

    // Flush any remaining buffered content after stream ends
    flushTextBuffer();
    flushReasoningBuffer();

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
        providerState: undefined,
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
      providerState: undefined,
    });
  } catch (error: unknown) {
    // Flush any buffered content before handling the error
    flushTextBuffer();
    flushReasoningBuffer();

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
          providerState: undefined,
        });
      } else {
        taskManager.updateTask(taskId, {
          status: TaskStatus.TIMED_OUT,
          endTime: nowIso(),
          error: `Task timed out after ${effectiveTimeout}ms`,
          timeoutReason: 'hard_timeout',
          exitCode: 124,
          providerState: undefined,
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
      providerState: undefined,
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
    // Clean up any zombie question left by handleAskUserQuestion
    try {
      const { questionRegistry: qr } = await import('./question-registry.js');
      if (qr.hasPendingQuestion(taskId)) {
        console.error(`[claude-code-runner] Clearing zombie question for task ${taskId}`);
        qr.clearQuestion(taskId, 'claude session ended');
      }
    } catch { /* swallow — cleanup must not block */ }
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

  // FB-013: Drain pending queue — increment count for each to balance the releaseFallbackSlot() the caller will hit
  while (fallbackQueue.length > 0) {
    const resolver = fallbackQueue.shift();
    if (resolver) {
      activeFallbackCount++;
      resolver();
    }
  }

  return aborted;
}
