/**
 * Answer Question Tool - Submit answers to pending SDK questions.
 * 
 * When Copilot's ask_user tool is invoked, the task pauses waiting for input.
 * This tool allows MCP clients to submit answers (choice index or custom text).
 */

import { z } from 'zod';
import { taskManager } from '../services/task-manager.js';
import { questionRegistry } from '../services/question-registry.js';
import { mcpText, mcpError } from '../utils/format.js';

const AnswerQuestionSchema = z.object({
  task_id: z.string().min(1).describe('Task ID with pending question'),
  answer: z.string().min(1).max(10000).describe('Answer: choice number (1, 2, 3...), exact choice text, or "CUSTOM: your answer"'),
});

export const answerAgentTool = {
  name: 'answer-agent',
  description: `Submit an answer to a pending question from an agent. When an agent pauses because it asked a question, use this to respond and resume execution.

**When to call:** Read \`task:///all\` — tasks with status \`waiting_answer\` have a "Pending Questions" section showing the question, choices, and an example answer-agent call.

**Answer formats:**
- **Choice by number**: \`"1"\`, \`"2"\`, \`"3"\` — selects the corresponding option
- **Choice by text**: Exact text of a choice option
- **Custom answer**: \`"CUSTOM: your custom text"\` — for freeform responses when choices don't fit

**Examples:**
\`\`\`
answer-agent { "task_id": "abc123", "answer": "2" }
answer-agent { "task_id": "abc123", "answer": "CUSTOM: Use TypeScript instead" }
\`\`\`

**Find pending questions:** Read \`task:///all\` — look for the "Pending Questions" section.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        minLength: 1,
        description: 'Task ID with pending question. Find via task:///all — look for waiting_answer status.',
      },
      answer: {
        type: 'string',
        minLength: 1,
        maxLength: 10000,
        description: 'Answer: choice number (1, 2, 3...), exact choice text, or "CUSTOM: your answer".',
      },
    },
    required: ['task_id', 'answer'],
  },
  annotations: {
    title: 'Answer Agent',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export async function handleAnswerQuestion(args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  try {
    const parsed = AnswerQuestionSchema.parse(args || {});
    const taskId = parsed.task_id.toLowerCase().trim();

    // Check if task exists
    const task = taskManager.getTask(taskId);
    if (!task) {
      return mcpError('Task not found', 'Read resource `task:///all` to find valid task IDs.');
    }

    // Check if there's a pending question
    if (!questionRegistry.hasPendingQuestion(taskId)) {
      // Check if task has pendingQuestion in state (might be stale)
      if (task.pendingQuestion) {
        return mcpError(
          'Question registry mismatch',
          'Task shows pending question but registry is empty. The question may have timed out.'
        );
      }
      return mcpError(
        'No pending question',
        `Task \`${taskId}\` does not have a pending question. Read resource \`task:///all\` to check status.`
      );
    }

    // Get the question for context
    const question = questionRegistry.getQuestion(taskId);

    // Submit the answer
    const result = questionRegistry.submitAnswer(taskId, parsed.answer);

    if (!result.success) {
      // Build helpful error message with valid options
      const parts: string[] = [`**Error:** ${result.error}`, ''];

      if (question) {
        parts.push(`**Question:** ${question.question}`);

        if (question.choices && question.choices.length > 0) {
          parts.push('');
          parts.push('**Valid options:**');
          question.choices.forEach((choice, i) => {
            parts.push(`- \`${i + 1}\` → ${choice}`);
          });
        }

        if (question.allowFreeform) {
          parts.push('');
          parts.push('**Custom answer:** `CUSTOM: your answer here`');
        }
      }

      return { content: [{ type: 'text', text: parts.join('\n') }], isError: true as const };
    }

    // Success - build confirmation
    const parts: (string | null)[] = [
      `✅ **Answer submitted**`,
      `task_id: \`${taskId}\``,
      '',
      question ? `**Question:** ${question.question}` : null,
      `**Answer:** ${result.resolvedAnswer}`,
      '',
      'Task resumed. Read `task:///all` every ~30s to track progress — status changes to `running`.',
    ];

    return mcpText(parts.filter(Boolean).join('\n'));

  } catch (error) {
    if (error instanceof z.ZodError) {
      return mcpError('Invalid input', 'Required: task_id (string), answer (string)');
    }
    return mcpError(
      error instanceof Error ? error.message : 'Unknown error',
      'Check task_id is valid and task has a pending question.'
    );
  }
}
