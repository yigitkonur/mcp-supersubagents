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

import type { UserInputResponse } from '@github/copilot-sdk';
import { taskManager } from './task-manager.js';
import { TaskStatus, isTerminalStatus } from '../types.js';
import type { PendingQuestion } from '../types.js';

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
  resolve: (response: UserInputResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
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
    allowFreeform: boolean = true
  ): Promise<UserInputResponse> {
    // Enforce max concurrent pending questions to prevent unbounded memory growth
    if (this.bindings.size >= MAX_PENDING_QUESTIONS && !this.bindings.has(taskId.toLowerCase())) {
      console.error(`[question-registry] Capacity exceeded: ${this.bindings.size}/${MAX_PENDING_QUESTIONS} pending questions. Rejecting question for task ${taskId}.`);
      return Promise.reject(new Error(`Question registry at capacity (${MAX_PENDING_QUESTIONS}). Cannot accept new questions until existing ones are answered or expire.`));
    }

    // Clean up any existing question for this task
    this.clearQuestion(taskId, 'new question asked');

    return new Promise<UserInputResponse>((resolve, reject) => {
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
      };

      this.bindings.set(taskId.toLowerCase(), binding);

      // Update task state with pending question
      const pendingQuestion: PendingQuestion = {
        question,
        choices,
        allowFreeform,
        askedAt: askedAt.toISOString(),
        sessionId,
      };

      taskManager.updateTask(taskId, { pendingQuestion });
      taskManager.appendOutput(taskId, `\n[question] Copilot is asking: ${question}`);
      
      if (choices && choices.length > 0) {
        const choiceList = choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
        taskManager.appendOutput(taskId, `[question] Options:\n${choiceList}`);
      }
      
      if (allowFreeform) {
        taskManager.appendOutput(taskId, `[question] Custom answers are allowed.`);
      }

      taskManager.appendOutput(taskId, `[question] Task paused. Use answer_question tool to respond.`);

      console.error(`[question-registry] Question registered for task ${taskId}: "${question}"`);

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

    // Resolve the Promise
    binding.resolve({
      answer: parseResult.answer!,
      wasFreeform: parseResult.wasFreeform!,
    });

    // Clear the pending question from task state
    taskManager.updateTask(taskId, { pendingQuestion: undefined });
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
   * Parse and validate an answer.
   * Supports: "1", "2", "3" (choice index), "CUSTOM: text", or direct text.
   */
  private parseAnswer(
    answer: string,
    choices?: string[],
    allowFreeform: boolean = true
  ): { valid: boolean; answer?: string; wasFreeform?: boolean; error?: string } {
    const trimmedAnswer = answer.trim();

    // Check for CUSTOM: prefix
    if (trimmedAnswer.toUpperCase().startsWith('CUSTOM:')) {
      if (!allowFreeform) {
        return { valid: false, error: 'Custom answers not allowed. Please select from the choices.' };
      }
      let customText = trimmedAnswer.slice(7).trim();
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
        error: `Invalid answer. Please select a choice (1-${choices.length}) or use "CUSTOM: your answer" if freeform is enabled.`,
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
