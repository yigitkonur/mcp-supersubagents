/**
 * Session Snapshot Builder
 *
 * Extracts bounded context from a Copilot session for handoff to Claude Agent SDK.
 * Provides last N turns with message truncation to prevent excessive context size.
 */

import { readFile } from 'fs/promises';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { TaskState } from '../types.js';

const MAX_TURNS = 5; // Max number of turns to include
const MAX_MESSAGE_LENGTH = 2000; // Max chars per message
const MAX_TOTAL_LENGTH = 20000; // Max total snapshot size

interface MessagePair {
  user: string;
  assistant: string;
}

/**
 * Parse output file and extract recent message pairs.
 * Simple heuristic: split on common markers.
 */
async function parseOutputFile(filePath: string): Promise<MessagePair[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const pairs: MessagePair[] = [];
    const lines = content.split('\n');
    let currentAssistant = '';

    const flushTurn = (): void => {
      const trimmed = currentAssistant.trim();
      if (trimmed) {
        pairs.push({ user: '', assistant: trimmed });
      }
      currentAssistant = '';
    };

    for (const line of lines) {
      // Turn boundaries: split on turn markers to produce multiple MessagePairs
      if (/^\[Assistant Turn \d+\]/.test(line) || /^--- Turn \d+ ---/.test(line)) {
        flushTurn();
        continue;
      }

      // Skip header lines (task metadata)
      if (line.startsWith('# ') || line.startsWith('─')) {
        continue;
      }

      // Skip empty lines between sections
      if (line.trim().length === 0) {
        if (currentAssistant.length > 0) {
          currentAssistant += '\n';
        }
        continue;
      }

      // Preserve tool completion summaries and errors (useful context for handoff)
      if (line.startsWith('[tool] Completed:') || line.startsWith('[error]') || line.startsWith('[summary]')) {
        currentAssistant += line + '\n';
        continue;
      }

      // Skip other system/tool lines
      if (line.startsWith('[') || line.startsWith('>')) {
        continue;
      }

      // Accumulate assistant output
      currentAssistant += line + '\n';
    }

    flushTurn();
    return pairs;
  } catch (error) {
    console.warn(`[session-snapshot] Failed to read output file: ${error}`);
    return [];
  }
}

/**
 * Truncate a message to max length with ellipsis.
 */
function truncateMessage(msg: string, maxLength: number): string {
  if (msg.length <= maxLength) {
    return msg;
  }
  return msg.slice(0, maxLength - 3) + '...';
}

function pairsFromSessionEvents(events: SessionEvent[]): MessagePair[] {
  const pairs: MessagePair[] = [];
  let pendingUser = '';
  let pendingAssistant = '';

  const flush = (): void => {
    if (pendingUser.trim() || pendingAssistant.trim()) {
      pairs.push({
        user: pendingUser.trim(),
        assistant: pendingAssistant.trim(),
      });
    }
    pendingUser = '';
    pendingAssistant = '';
  };

  for (const event of events) {
    if (event.type === 'user.message') {
      if (pendingAssistant.trim()) {
        flush();
      }
      const content = event.data.content?.trim();
      if (content) {
        pendingUser = content;
      }
      continue;
    }

    if (event.type === 'assistant.message') {
      const content = event.data.content?.trim();
      if (!content) continue;

      if (pendingAssistant.trim()) {
        pendingAssistant += '\n\n' + content;
      } else {
        pendingAssistant = content;
      }
      flush();
    }
  }

  flush();
  return pairs;
}

function fallbackReasonIntro(reason?: string): string {
  switch (reason) {
    case 'copilot_startup_no_accounts':
      return 'No Copilot account is currently available, so you are taking over before initial execution.';
    case 'copilot_accounts_exhausted':
      return 'All Copilot accounts are currently exhausted, so you are taking over.';
    case 'copilot_rate_limited':
      return 'The Copilot session is rate-limited and cannot continue within policy, so you are taking over.';
    case 'copilot_non_rotatable_error':
      return 'The Copilot session hit a non-rotatable error, so you are taking over.';
    case 'copilot_unhandled_error':
      return 'The Copilot path hit an unhandled error, so you are taking over.';
    default:
      return 'The previous Copilot path cannot continue, so you are taking over.';
  }
}

/**
 * Build handoff prompt from session snapshot.
 * Includes original prompt and bounded recent context.
 */
export async function buildHandoffPrompt(task: TaskState, maxTurns: number = MAX_TURNS, reason?: string): Promise<string> {
  const parts: string[] = [];

  // Header explaining the handoff
  parts.push('You are continuing a task that started with GitHub Copilot SDK.');
  parts.push(fallbackReasonIntro(reason));
  parts.push('');

  // Original prompt
  parts.push(`Original task prompt:\n${task.prompt}`);
  parts.push('');

  // Extract recent context if output file exists
  if (task.outputFilePath) {
    const pairs = await parseOutputFile(task.outputFilePath);
    const recentPairs = pairs.slice(-maxTurns);

    if (recentPairs.length > 0) {
      parts.push('Recent context from the Copilot session:');
      parts.push('');

      for (const pair of recentPairs) {
        if (pair.user) {
          const truncated = truncateMessage(pair.user, MAX_MESSAGE_LENGTH);
          parts.push(`User: ${truncated}`);
          parts.push('');
        }
        if (pair.assistant) {
          const truncated = truncateMessage(pair.assistant, MAX_MESSAGE_LENGTH);
          parts.push(`Assistant: ${truncated}`);
          parts.push('');
        }
      }
    }
  }

  // Footer with instruction
  parts.push('Please continue working on this task. Pick up where the Copilot session left off.');

  // Join and enforce total length limit
  const snapshot = parts.join('\n');
  if (snapshot.length > MAX_TOTAL_LENGTH) {
    return snapshot.slice(0, MAX_TOTAL_LENGTH - 100) + '\n\n...[context truncated]\n\nPlease continue working on the original task.';
  }

  return snapshot;
}

/**
 * Build handoff prompt with structured SDK history when available.
 * Falls back to output-file snapshot if session history is unavailable.
 */
export async function buildHandoffPromptFromSession(
  task: TaskState,
  session: CopilotSession | undefined,
  maxTurns: number = MAX_TURNS,
  reason?: string
): Promise<string> {
  if (!session) {
    return await buildHandoffPrompt(task, maxTurns, reason);
  }

  let events: SessionEvent[];
  try {
    events = await session.getMessages();
  } catch (err) {
    console.error(`[session-snapshot] Failed to get session messages (session may be shutting down): ${err}`);
    return await buildHandoffPrompt(task, maxTurns, reason);
  }

  try {
    const pairs = pairsFromSessionEvents(events);
    if (pairs.length === 0) {
      return await buildHandoffPrompt(task, maxTurns, reason);
    }

    const parts: string[] = [];
    parts.push('You are continuing a task that started with GitHub Copilot SDK.');
    parts.push(fallbackReasonIntro(reason));
    parts.push('');
    parts.push(`Original task prompt:\n${task.prompt}`);
    parts.push('');
    parts.push('Recent context from structured Copilot session history:');
    parts.push('');

    for (const pair of pairs.slice(-maxTurns)) {
      if (pair.user) {
        parts.push(`User: ${truncateMessage(pair.user, MAX_MESSAGE_LENGTH)}`);
        parts.push('');
      }
      if (pair.assistant) {
        parts.push(`Assistant: ${truncateMessage(pair.assistant, MAX_MESSAGE_LENGTH)}`);
        parts.push('');
      }
    }

    parts.push('Please continue working on this task. Pick up where the Copilot session left off.');

    const snapshot = parts.join('\n');
    if (snapshot.length > MAX_TOTAL_LENGTH) {
      return snapshot.slice(0, MAX_TOTAL_LENGTH - 100) + '\n\n...[context truncated]\n\nPlease continue working on the original task.';
    }
    return snapshot;
  } catch (error) {
    console.warn(`[session-snapshot] Failed to load session history: ${error}`);
    return await buildHandoffPrompt(task, maxTurns, reason);
  }
}
