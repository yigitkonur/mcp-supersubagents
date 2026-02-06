/**
 * Session Snapshot Builder
 *
 * Extracts bounded context from a Copilot session for handoff to Claude Agent SDK.
 * Provides last N turns with message truncation to prevent excessive context size.
 */

import { readFileSync } from 'fs';
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
function parseOutputFile(filePath: string): MessagePair[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const pairs: MessagePair[] = [];

    // Split by common output markers
    const lines = content.split('\n');
    let currentUser = '';
    let currentAssistant = '';
    let isAssistant = false;

    for (const line of lines) {
      // Detect assistant output (simple heuristic - lines without user markers)
      if (line.startsWith('[') || line.startsWith('>') || line.trim().length === 0) {
        // System/tool output, skip
        continue;
      }

      // Accumulate assistant output
      if (!isAssistant) {
        isAssistant = true;
        currentAssistant = '';
      }
      currentAssistant += line + '\n';
    }

    // If we have any output, treat it as one big assistant turn
    if (currentAssistant.trim()) {
      pairs.push({
        user: '',
        assistant: currentAssistant.trim(),
      });
    }

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

/**
 * Build handoff prompt from session snapshot.
 * Includes original prompt and bounded recent context.
 */
export function buildHandoffPrompt(task: TaskState, maxTurns: number = MAX_TURNS): string {
  const parts: string[] = [];

  // Header explaining the handoff
  parts.push('You are continuing a task that started with GitHub Copilot SDK.');
  parts.push('All Copilot accounts are currently exhausted, so you are taking over.');
  parts.push('');

  // Original prompt
  parts.push(`Original task prompt:\n${task.prompt}`);
  parts.push('');

  // Extract recent context if output file exists
  if (task.outputFilePath) {
    const pairs = parseOutputFile(task.outputFilePath);
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
