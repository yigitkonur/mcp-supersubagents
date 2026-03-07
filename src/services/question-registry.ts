/**
 * Question Registry - Manages pending questions from SDK's ask_user tool.
 * 
 * When the agent asks a question via ask_user, this registry:
 * - Stores the question with Promise callbacks for resolution
 * - Updates TaskState with pending question
 * - Provides answer submission with validation
 * - Handles timeouts (30 min default)
 * - Sends MCP notifications when questions arrive
 */

import { taskManager } from './task-manager.js';
import { TaskStatus, isTerminalStatus } from '../types.js';
import type { PendingQuestion, StructuredQuestion, QuestionResponse } from '../types.js';

const QUESTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PENDING_QUESTIONS = 50;
// Unified control-char regex: C0 (minus TAB, LF, CR), DEL, and C1
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

interface QuestionBinding {
  taskId: string;
  sessionId: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  askedAt: Date;
  timeoutId: NodeJS.Timeout;
  resolve: (response: QuestionResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
  structuredQuestions?: StructuredQuestion[];
}

// MCP notification callback type
type QuestionNotificationCallback = (
  taskId: string,
  question: PendingQuestion
) => void;

class QuestionRegistry {
  private bindings: Map<string, QuestionBinding> = new Map();
  private notificationCallback?: QuestionNotificationCallback;

  /**
   * Set callback for MCP notifications when questions arrive.
   */
  onQuestionAsked(callback: QuestionNotificationCallback): void {
    this.notificationCallback = callback;
  }

  /**
   * Register a pending question and return a Promise that resolves when answered.
   * This is called from the SDK's onUserInputRequest handler.
   */
  register(
    taskId: string,
    sessionId: string,
    question: string,
    choices?: string[],
    allowFreeform: boolean = true,
    source: string = 'Copilot',
    structuredQuestions?: StructuredQuestion[],
  ): Promise<QuestionResponse> {
    // Enforce max concurrent pending questions to prevent unbounded memory growth
    if (this.bindings.size >= MAX_PENDING_QUESTIONS && !this.bindings.has(taskId.toLowerCase())) {
      console.error(`[question-registry] Capacity exceeded: ${this.bindings.size}/${MAX_PENDING_QUESTIONS} pending questions. Rejecting question for task ${taskId}.`);
      return Promise.reject(new Error(`Question registry at capacity (${MAX_PENDING_QUESTIONS}). Cannot accept new questions until existing ones are answered or expire.`));
    }

    // Clean up any existing question for this task
    this.clearQuestion(taskId, 'new question asked');

    return new Promise<QuestionResponse>((resolve, reject) => {
      const askedAt = new Date();

      // Set timeout for question
      const timeoutId = setTimeout(() => {
        this.handleTimeout(taskId);
      }, QUESTION_TIMEOUT_MS);
      if (timeoutId.unref) timeoutId.unref();

      const binding: QuestionBinding = {
        taskId,
        sessionId,
        question,
        choices,
        allowFreeform,
        askedAt,
        timeoutId,
        resolve,
        reject,
        settled: false,
        structuredQuestions,
      };

      this.bindings.set(taskId.toLowerCase(), binding);

      // Update task state with pending question
      const pendingQuestion: PendingQuestion = {
        question,
        choices,
        allowFreeform,
        askedAt: askedAt.toISOString(),
        sessionId,
        source,
        structuredQuestions,
      };

      taskManager.updateTask(taskId, { pendingQuestion, status: TaskStatus.WAITING_ANSWER });

      // Build rich file-output block so anyone tailing the output knows exactly what to call
      const lines: string[] = [];
      lines.push('');
      lines.push('[question] ━━━━━━━━━━━━ EXECUTION PAUSED ━━━━━━━━━━━━');
      lines.push(`[question] ${source} is waiting for your input.`);
      lines.push('[question] Respond using the answer-agent MCP tool, then execution resumes.');
      lines.push('[question]');

      if (structuredQuestions && structuredQuestions.length > 0) {
        // Multi-question structured flow (Codex ask_user)
        for (let i = 0; i < structuredQuestions.length; i++) {
          const sq = structuredQuestions[i];
          lines.push(`[question] Q${i + 1} [${sq.id}] — ${sq.question}`);
          if (sq.options && sq.options.length > 0) {
            for (let j = 0; j < sq.options.length; j++) {
              const opt = sq.options[j];
              const desc = opt.description ? ` — ${opt.description}` : '';
              lines.push(`[question]   ${j + 1}. ${opt.label}${desc}`);
            }
          }
          if (sq.allowFreeform !== false) {
            lines.push(`[question]   OTHER: <any custom text>`);
          }
          lines.push('[question]');
        }

        lines.push('[question] ANSWER FORMATS (pick one style per question):');
        lines.push('[question]   "N"           — select option by number, e.g. "2"');
        lines.push('[question]   "N: detail"   — select option + add context, e.g. "1: Smile Dental Clinic"');
        lines.push('[question]   "OTHER: text" — full custom answer, e.g. "OTHER: implants, whitening"');
        lines.push('[question]');

        // Build ready-to-copy answer-agent call
        const answerEntries = structuredQuestions.map(sq => {
          const range = sq.options && sq.options.length > 0
            ? `"1"–"${sq.options.length}" | "N: detail" | "OTHER: text"`
            : '"OTHER: text"';
          return `[question]   "${sq.id}": ${range}`;
        });
        lines.push(`[question] ─ CALL: answer-agent ─────────────────────────────`);
        lines.push(`[question] { "task_id": "${taskId}", "answers": {`);
        for (const entry of answerEntries) {
          lines.push(`${entry},`);
        }
        lines.push('[question] }}');
      } else {
        // Single-question flow (Copilot / Claude style)
        lines.push(`[question] ${question}`);
        if (choices && choices.length > 0) {
          for (let i = 0; i < choices.length; i++) {
            lines.push(`[question]   ${i + 1}. ${choices[i]}`);
          }
        }
        if (allowFreeform) {
          lines.push('[question]   OTHER: <any custom text>');
        }
        lines.push('[question]');
        lines.push(`[question] ─ CALL: answer-agent ─────────────────────────────`);
        lines.push(`[question] { "task_id": "${taskId}", "answer": "1" | "OTHER: text" }`);
      }

      lines.push('[question] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      taskManager.appendOutput(taskId, lines.join('\n'));

      console.error(`[question-registry] ${source} question registered for task ${taskId}: "${question}"`);

      // Send MCP notification
      if (this.notificationCallback) {
        this.notificationCallback(taskId, pendingQuestion);
      }
    });
  }

  /**
   * Submit an answer for a pending question.
   * Validates the answer format and resolves the Promise.
   */
  submitAnswer(
    taskId: string,
    answer: string
  ): { success: boolean; error?: string; resolvedAnswer?: string; wasFreeform?: boolean } {
    const normalizedId = taskId.toLowerCase();
    const binding = this.bindings.get(normalizedId);

    if (!binding) {
      return { success: false, error: 'No pending question for this task' };
    }

    if (binding.settled) {
      return { success: false, error: 'Question already resolved (likely timed out)' };
    }

    // Parse and validate the answer
    const parseResult = this.parseAnswer(answer, binding.choices, binding.allowFreeform);
    
    if (!parseResult.valid) {
      return { success: false, error: parseResult.error };
    }
    binding.settled = true;

    // Clear timeout
    clearTimeout(binding.timeoutId);

    // Resolve the Promise with single-answer response
    binding.resolve({
      kind: 'single',
      answer: parseResult.answer!,
      wasFreeform: parseResult.wasFreeform!,
    });

    // Clear the pending question and resume running
    taskManager.updateTask(taskId, { pendingQuestion: undefined, status: TaskStatus.RUNNING });
    taskManager.appendOutput(taskId, `[question] Answer submitted: ${parseResult.answer}`);

    // Remove from registry
    this.bindings.delete(normalizedId);

    console.error(`[question-registry] Answer submitted for task ${taskId}: "${parseResult.answer}" (freeform: ${parseResult.wasFreeform})`);

    return {
      success: true,
      resolvedAnswer: parseResult.answer,
      wasFreeform: parseResult.wasFreeform,
    };
  }

  /**
   * Submit structured answers for a multi-question Codex flow.
   * `answers` is a map of question ID → answer string (numeric index, label, or freeform).
   */
  submitStructuredAnswers(
    taskId: string,
    answers: Record<string, string>,
  ): { success: boolean; error?: string; answeredCount?: number } {
    const normalizedId = taskId.toLowerCase();
    const binding = this.bindings.get(normalizedId);

    if (!binding) {
      return { success: false, error: 'No pending question for this task' };
    }
    if (binding.settled) {
      return { success: false, error: 'Question already resolved (likely timed out)' };
    }

    const structuredQuestions = binding.structuredQuestions;
    if (!structuredQuestions || structuredQuestions.length === 0) {
      return { success: false, error: 'Task has a single-question flow. Use answer (not answers) to respond.' };
    }

    // Validate each answer and build the response map
    const resolvedAnswers: Record<string, { answers: string[] }> = {};
    // Track how each answer was resolved for output logging
    const resolvedLog: string[] = [];

    for (const q of structuredQuestions) {
      const raw = answers[q.id];
      if (raw === undefined) {
        return { success: false, error: `Missing answer for question "${q.id}" (${q.question})` };
      }

      const trimmed = raw.trim();
      if (!trimmed) {
        return { success: false, error: `Answer for question "${q.id}" cannot be empty` };
      }

      // "OTHER: text" — explicit freeform escape hatch (strip prefix)
      const otherMatch = /^OTHER:\s*([\s\S]+)$/i.exec(trimmed);
      if (otherMatch) {
        if (q.allowFreeform === false) {
          return { success: false, error: `Freeform not allowed for question "${q.id}". Use option number 1–${q.options?.length ?? '?'}.` };
        }
        const otherText = otherMatch[1].trim().replace(CONTROL_CHAR_RE, '');
        if (!otherText) {
          return { success: false, error: `"OTHER:" requires text after the colon for question "${q.id}"` };
        }
        resolvedAnswers[q.id] = { answers: [otherText] };
        resolvedLog.push(`  ${q.id} → "${otherText}" (freeform via OTHER:)`);
        continue;
      }

      // "N: comment" — pick option N and attach detail text
      const numCommentMatch = /^(\d+):\s*([\s\S]+)$/.exec(trimmed);
      if (numCommentMatch && q.options && q.options.length > 0) {
        const idx = parseInt(numCommentMatch[1], 10) - 1;
        if (idx >= 0 && idx < q.options.length) {
          const comment = numCommentMatch[2].trim().replace(CONTROL_CHAR_RE, '');
          // Send option label + detail so the model has both the selected intent and the user's content
          resolvedAnswers[q.id] = { answers: [`${q.options[idx].label}: ${comment}`] };
          resolvedLog.push(`  ${q.id} → option ${idx + 1} "${q.options[idx].label}" with detail: "${comment}"`);
          continue;
        }
        // Number out of range — fall through to freeform or error below
      }

      // Pure numeric index "N"
      if (q.options && q.options.length > 0 && /^\d+$/.test(trimmed)) {
        const idx = parseInt(trimmed, 10) - 1;
        if (idx >= 0 && idx < q.options.length) {
          resolvedAnswers[q.id] = { answers: [q.options[idx].label] };
          resolvedLog.push(`  ${q.id} → option ${idx + 1} "${q.options[idx].label}"`);
          continue;
        }
        return { success: false, error: `Invalid choice index "${raw}" for question "${q.id}". Valid range: 1-${q.options.length}` };
      }

      // Exact option label match (case-insensitive)
      if (q.options && q.options.length > 0) {
        const match = q.options.find(o => o.label.toLowerCase() === trimmed.toLowerCase());
        if (match) {
          resolvedAnswers[q.id] = { answers: [match.label] };
          resolvedLog.push(`  ${q.id} → label match "${match.label}"`);
          continue;
        }
      }

      // Plain freeform (no prefix needed when allowFreeform is true)
      if (q.allowFreeform !== false) {
        const sanitized = trimmed.replace(CONTROL_CHAR_RE, '');
        resolvedAnswers[q.id] = { answers: [sanitized] };
        resolvedLog.push(`  ${q.id} → "${sanitized}" (freeform)`);
        continue;
      }

      const validLabels = q.options?.map((o, i) => `${i + 1}. ${o.label}`).join(', ') ?? '(none)';
      return { success: false, error: `Invalid answer for question "${q.id}". Valid options: ${validLabels}` };
    }

    binding.settled = true;
    clearTimeout(binding.timeoutId);

    binding.resolve({ kind: 'structured', answers: resolvedAnswers });

    taskManager.updateTask(taskId, { pendingQuestion: undefined });

    // Log resolved answers and resume signal
    const resumeLines: string[] = [
      `[question] ━━━━━━━━━━━━ ANSWERS RECEIVED ━━━━━━━━━━━━`,
      `[question] ${Object.keys(resolvedAnswers).length} answer(s) submitted:`,
      ...resolvedLog.map(l => `[question] ${l}`),
      `[question]`,
      `[question] EXECUTION RESUMING — task continuing`,
      `[question] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ];
    taskManager.appendOutput(taskId, resumeLines.join('\n'));

    this.bindings.delete(normalizedId);
    console.error(`[question-registry] Structured answers submitted for task ${taskId}: ${Object.keys(resolvedAnswers).join(', ')}`);

    return { success: true, answeredCount: Object.keys(resolvedAnswers).length };
  }

  /**
   * Parse and validate an answer.
   * Supports: "1", "2", "3" (choice index), "CUSTOM: text", or direct text.
   */
  private parseAnswer(
    answer: string,
    choices?: string[],
    allowFreeform: boolean = true
  ): { valid: boolean; answer?: string; wasFreeform?: boolean; error?: string } {
    const trimmedAnswer = answer.trim();

    // Accept both CUSTOM: and OTHER: as freeform prefix (consistent with structured flow)
    if (trimmedAnswer.toUpperCase().startsWith('CUSTOM:') || trimmedAnswer.toUpperCase().startsWith('OTHER:')) {
      if (!allowFreeform) {
        return { valid: false, error: 'Custom answers not allowed. Please select from the choices.' };
      }
      const colonIdx = trimmedAnswer.indexOf(':');
      let customText = trimmedAnswer.slice(colonIdx + 1).trim();
      if (!customText) {
        return { valid: false, error: 'Custom answer cannot be empty.' };
      }
      customText = customText.replace(CONTROL_CHAR_RE, '');
      return { valid: true, answer: customText, wasFreeform: true };
    }

    // Check for numeric choice (1-indexed)
    if (choices && choices.length > 0 && /^\d+$/.test(trimmedAnswer)) {
      const index = parseInt(trimmedAnswer, 10) - 1; // Convert to 0-indexed
      if (index >= 0 && index < choices.length) {
        return { valid: true, answer: choices[index], wasFreeform: false };
      }
      return { valid: false, error: `Invalid choice. Please enter 1-${choices.length}.` };
    }

    // Check if answer matches a choice exactly
    if (choices && choices.length > 0) {
      const matchIndex = choices.findIndex(
        c => c.toLowerCase() === trimmedAnswer.toLowerCase()
      );
      if (matchIndex >= 0) {
        return { valid: true, answer: choices[matchIndex], wasFreeform: false };
      }
    }

    // Freeform answer
    if (allowFreeform) {
      if (!trimmedAnswer) {
        return { valid: false, error: 'Answer cannot be empty.' };
      }
      const sanitized = trimmedAnswer.replace(CONTROL_CHAR_RE, '');
      return { valid: true, answer: sanitized, wasFreeform: true };
    }

    // Not allowed
    if (choices && choices.length > 0) {
      return {
        valid: false,
        error: `Invalid answer. Please select a choice (1-${choices.length}) or use "OTHER: your answer" if freeform is enabled.`,
      };
    }

    return { valid: false, error: 'Cannot submit answer.' };
  }

  /**
   * Handle question timeout.
   */
  private handleTimeout(taskId: string): void {
    const normalizedId = taskId.toLowerCase();
    const binding = this.bindings.get(normalizedId);

    if (binding) {
      if (binding.settled) {
        this.bindings.delete(normalizedId);
        return;
      }

      const task = taskManager.getTask(taskId);
      if (!task || isTerminalStatus(task.status)) {
        taskManager.updateTask(taskId, { pendingQuestion: undefined });
        this.bindings.delete(normalizedId);
        return;
      }
      binding.settled = true;

      binding.reject(new Error('Question timed out after 30 minutes — task will be terminated'));
      
      taskManager.updateTask(taskId, {
        pendingQuestion: undefined,
        status: TaskStatus.FAILED,
        error: 'Task failed: user question timed out after 30 minutes',
        endTime: new Date().toISOString(),
      });
      taskManager.appendOutput(taskId, `[question] Question timed out after 30 minutes. Task failed.`);

      this.bindings.delete(normalizedId);

      console.error(`[question-registry] Question timed out for task ${taskId} — task marked FAILED`);
    }
  }

  /**
   * Clear a pending question for a task.
   */
  clearQuestion(taskId: string, reason: string = 'cleared'): void {
    const normalizedId = taskId.toLowerCase();
    const binding = this.bindings.get(normalizedId);

    if (binding) {
      if (binding.settled) {
        this.bindings.delete(normalizedId);
        return;
      }
      binding.settled = true;

      clearTimeout(binding.timeoutId);
      binding.reject(new Error(`Question cleared: ${reason}`));

      taskManager.updateTask(taskId, { pendingQuestion: undefined });

      // Restore to RUNNING if still in WAITING_ANSWER
      const t = taskManager.getTask(taskId);
      if (t && t.status === TaskStatus.WAITING_ANSWER) {
        taskManager.updateTask(taskId, { status: TaskStatus.RUNNING });
      }

      this.bindings.delete(normalizedId);

      console.error(`[question-registry] Question cleared for task ${taskId}: ${reason}`);
    }
  }

  /**
   * Get the pending question for a task.
   */
  getQuestion(taskId: string): PendingQuestion | undefined {
    const binding = this.bindings.get(taskId.toLowerCase());
    if (!binding) return undefined;

    return {
      question: binding.question,
      choices: binding.choices,
      allowFreeform: binding.allowFreeform,
      askedAt: binding.askedAt.toISOString(),
      sessionId: binding.sessionId,
      structuredQuestions: binding.structuredQuestions,
    };
  }

  /**
   * Check if a task has a pending question.
   */
  hasPendingQuestion(taskId: string): boolean {
    return this.bindings.has(taskId.toLowerCase());
  }

  /**
   * Get all tasks with pending questions.
   */
  getAllPendingQuestions(): Map<string, PendingQuestion> {
    const result = new Map<string, PendingQuestion>();

    for (const [taskId, binding] of this.bindings) {
      result.set(taskId, {
        question: binding.question,
        choices: binding.choices,
        allowFreeform: binding.allowFreeform,
        askedAt: binding.askedAt.toISOString(),
        sessionId: binding.sessionId,
        structuredQuestions: binding.structuredQuestions,
      });
    }

    return result;
  }

  /**
   * Clean up all pending questions (e.g., on server shutdown).
   */
  cleanup(): void {
    for (const [taskId, binding] of this.bindings) {
      binding.settled = true;
      clearTimeout(binding.timeoutId);
      binding.reject(new Error('Server shutdown'));
    }
    this.bindings.clear();
    console.error(`[question-registry] Cleaned up all pending questions`);
  }

  /**
   * Get statistics.
   */
  getStats(): { pendingCount: number; oldestQuestionAge?: number } {
    const now = Date.now();
    let oldestAge: number | undefined;

    for (const binding of this.bindings.values()) {
      const age = now - binding.askedAt.getTime();
      if (oldestAge === undefined || age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      pendingCount: this.bindings.size,
      oldestQuestionAge: oldestAge,
    };
  }
}

export const questionRegistry = new QuestionRegistry();
