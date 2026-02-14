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
  answer: z.string().min(1).describe('Answer: choice number (1, 2, 3...), exact choice text, or "CUSTOM: your answer"'),
});

export const answerQuestionTool = {
  name: 'answer_question',
  description: `Submit an answer to a pending question from Copilot.

When a task is paused because Copilot asked a question (via ask_user tool), use this to respond.

**Answer formats:**
- **Choice by number**: \`"1"\`, \`"2"\`, \`"3"\` - selects the corresponding option
- **Choice by text**: Exact text of a choice option
- **Custom answer**: \`"CUSTOM: your custom text"\` - for freeform responses

**Example:**
\`\`\`
answer_question { "task_id": "abc123", "answer": "2" }
answer_question { "task_id": "abc123", "answer": "CUSTOM: Use TypeScript instead" }
\`\`\`

Check pending questions via resource \`task:///all\`.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID with pending question',
      },
      answer: {
        type: 'string',
        description: 'Answer: choice number (1, 2, 3...), exact choice text, or "CUSTOM: your answer"',
      },
    },
    required: ['task_id', 'answer'],
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
      task.outputFilePath ? `output_file: \`${task.outputFilePath}\`` : null,
      '',
      question ? `**Question:** ${question.question}` : null,
      `**Answer:** ${result.resolvedAnswer}`,
      '',
      'Task execution resumed. MCP notifications will alert on completion—no need to poll.',
      '',
      '**Optional progress check:**',
      task.outputFilePath ? `- \`tail -20 ${task.outputFilePath}\` — Last 20 lines` : null,
      `- Read resource: \`task:///${taskId}\``,
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
