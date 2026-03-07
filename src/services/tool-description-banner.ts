/**
 * Tool Description Banner — embeds live task status into tool descriptions.
 *
 * When Claude Code re-fetches the tool list (via notifications/tools/list_changed),
 * the `description` getter on message-agent and answer-agent invokes these helpers
 * to append a compact status footer showing running/completed/question-pending tasks.
 *
 * Hard cap: 500 chars max for the banner to stay within tool description limits.
 */

import { taskManager } from './task-manager.js';
import { questionRegistry } from './question-registry.js';
import { mapInternalStatusToMCP } from './task-status-mapper.js';
import { TaskStatus, isTerminalStatus } from '../types.js';

const BANNER_MAX_CHARS = 500;
const RECENTLY_TERMINAL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build a compact status banner for message-agent.
 * Shows: running count, recently completed tasks, tasks needing answers.
 * Returns '' when nothing to report.
 */
export function buildStatusBanner(): string {
  const allTasks = taskManager.getAllTasks();
  if (allTasks.length === 0) return '';

  const now = Date.now();
  const running: { id: string; taskType?: string }[] = [];
  const recentlyTerminal: { id: string; status: string; taskType?: string; agoMs: number; outputFile?: string }[] = [];
  const needsAnswer: { id: string; taskType?: string }[] = [];

  for (const task of allTasks) {
    const hasPendingQuestion = questionRegistry.hasPendingQuestion(task.id);
    if ((task.status === TaskStatus.RUNNING || task.status === TaskStatus.PENDING || task.status === TaskStatus.WAITING) && !hasPendingQuestion) {
      running.push({ id: task.id, taskType: task.taskType });
    }

    if (isTerminalStatus(task.status) && task.endTime) {
      const agoMs = now - new Date(task.endTime).getTime();
      if (agoMs <= RECENTLY_TERMINAL_WINDOW_MS) {
        recentlyTerminal.push({
          id: task.id,
          status: mapInternalStatusToMCP(task.status),
          taskType: task.taskType,
          agoMs,
          outputFile: task.outputFilePath,
        });
      }
    }

    if (questionRegistry.hasPendingQuestion(task.id)) {
      needsAnswer.push({ id: task.id, taskType: task.taskType });
    }
  }

  if (running.length === 0 && recentlyTerminal.length === 0 && needsAnswer.length === 0) {
    return '';
  }

  const parts: string[] = ['---'];

  // Summary line
  const summaryParts: string[] = [];
  if (running.length > 0) summaryParts.push(`${running.length} running`);
  if (needsAnswer.length > 0) summaryParts.push(`${needsAnswer.length} needs answer`);
  if (recentlyTerminal.length > 0) summaryParts.push(`${recentlyTerminal.length} recently finished`);
  parts.push(`AGENT STATUS: ${summaryParts.join(' | ')}`);

  // Recently terminal tasks (most recent first, limit 3)
  const sorted = recentlyTerminal.sort((a, b) => a.agoMs - b.agoMs).slice(0, 3);
  for (const t of sorted) {
    const ago = t.agoMs < 60_000 ? `${Math.round(t.agoMs / 1000)}s ago` : `${Math.round(t.agoMs / 60_000)}min ago`;
    const role = t.taskType ? ` ${t.taskType.replace('super-', '')}` : '';
    const out = t.outputFile ? `  output: ${t.outputFile}` : '';
    parts.push(`- ${t.id} [${t.status}]${role} (${ago})${out}`);
  }

  // Tasks needing answers
  for (const t of needsAnswer) {
    parts.push(`- ${t.id} [input_required]${t.taskType ? ' ' + t.taskType.replace('super-', '') : ''} — waiting for answer`);
  }

  parts.push('Read task:///all for full details.');

  let banner = parts.join('\n');
  if (banner.length > BANNER_MAX_CHARS) {
    banner = banner.slice(0, BANNER_MAX_CHARS - 3) + '...';
  }
  return banner;
}

/**
 * Build a status banner specifically for answer-agent.
 * Only shows tasks with pending questions, including question text and choices.
 * Returns '' when no questions are pending.
 */
export function buildStatusBannerForAnswerAgent(): string {
  const pendingQuestions = questionRegistry.getAllPendingQuestions();
  if (pendingQuestions.size === 0) return '';

  const parts: string[] = ['---'];
  parts.push(`ACTION REQUIRED — ${pendingQuestions.size} task${pendingQuestions.size > 1 ? 's' : ''} waiting for your answer:`);

  for (const [taskId, question] of pendingQuestions) {
    let line = `- ${taskId}: "${question.question}"`;
    if (question.choices && question.choices.length > 0) {
      const choiceStr = question.choices.map((c, i) => `${i + 1}) ${c}`).join(' ');
      line += ` Options: ${choiceStr}`;
    }
    parts.push(line);
  }

  parts.push(`Use answer-agent { "task_id": "<id>", "answer": "<choice>" }`);

  let banner = parts.join('\n');
  if (banner.length > BANNER_MAX_CHARS) {
    banner = banner.slice(0, BANNER_MAX_CHARS - 3) + '...';
  }
  return banner;
}
