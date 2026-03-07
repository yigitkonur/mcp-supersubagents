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
  answer: z.string().min(1).max(10000).optional().describe('Single answer: choice number (1, 2, 3...), exact choice text, or "OTHER: your answer". Use for single-question flows (Copilot/Claude).'),
  answers: z.record(z.string(), z.string().min(1).max(10000)).optional().describe('Multi-question answer map: { "<questionId>": "<answer>" }. Use for Codex multi-question flows — read structured_questions[].id from task:///{id} to get the question IDs.'),
}).refine(d => d.answer !== undefined || d.answers !== undefined, {
  message: 'Provide either answer (single string) or answers (map of question IDs to answer strings)',
});

export const answerAgentTool = {
  name: 'answer-agent',
  description: `Submit an answer to a pending question from an agent. When an agent pauses because it asked a question (via ask_user tool), use this to respond and resume execution.

**When to call:** An agent's status shows "input_required" or the \`task:///all\` resource shows a pending question for a task.

**Single-question flows (Copilot / Claude):** Use the \`answer\` field.
- **Choice by number**: \`"1"\`, \`"2"\`, \`"3"\` — selects the corresponding option
- **Choice by text**: Exact text of a choice option
- **Custom answer**: \`"OTHER: your custom text"\` — for freeform responses when choices don't fit

**Multi-question flows (Codex):** Use the \`answers\` field with a map of question IDs to answers.
Read \`task:///{id}\` → \`pending_question.structured_questions\` to get question IDs.

**Examples:**
\`\`\`
answer-agent { "task_id": "abc123", "answer": "2" }
answer-agent { "task_id": "abc123", "answer": "OTHER: Use TypeScript instead" }
answer-agent { "task_id": "abc123", "answers": { "q_build_system": "1", "q_language": "TypeScript" } }
\`\`\`

**Find pending questions:** Read MCP Resource \`task:///all\` — tasks with \`has_pending_question: true\` need answers.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        minLength: 1,
        description: 'Task ID with pending question. Find via task:///all — look for has_pending_question: true.',
      },
      answer: {
        type: 'string',
        minLength: 1,
        maxLength: 10000,
        description: 'Single answer for single-question flows (Copilot/Claude): choice number (1, 2, 3...), exact choice text, or "OTHER: your answer". Mutually exclusive with answers.',
      },
      answers: {
        type: 'object',
        additionalProperties: { type: 'string', minLength: 1, maxLength: 10000 },
        description: 'Multi-question answer map for Codex flows: { "<questionId>": "<answer>" }. Read task:///{id} → pending_question.structured_questions[].id to get question IDs. Mutually exclusive with answer.',
      },
    },
    required: ['task_id'],
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

    // Route: multi-question (answers map) vs single-question (answer string)
    if (parsed.answers !== undefined) {
      // Multi-question Codex path
      if (!question?.structuredQuestions?.length) {
        return mcpError(
          'Invalid answer format',
          'This task has a single-question flow. Use answer (not answers) to respond.',
        );
      }

      const result = questionRegistry.submitStructuredAnswers(taskId, parsed.answers);

      if (!result.success) {
        const parts: string[] = [`**Error:** ${result.error}`, ''];
        parts.push('**Structured questions:**');
        for (const sq of question.structuredQuestions) {
          parts.push(`- \`${sq.id}\` — ${sq.question}`);
          if (sq.options && sq.options.length > 0) {
            sq.options.forEach((o, i) => parts.push(`  ${i + 1}. ${o.label}`));
          }
          if (sq.allowFreeform) parts.push('  *(freeform allowed)*');
        }
        return { content: [{ type: 'text', text: parts.join('\n') }], isError: true as const };
      }

      const successParts: (string | null)[] = [
        `✅ **Structured answers submitted** (${result.answeredCount} question(s))`,
        `task_id: \`${taskId}\``,
        task.outputFilePath ? `read logs: \`cat -n ${task.outputFilePath}\`` : null,
        task.outputFilePath ? `Use \`cat -n\` to read with line numbers, then on subsequent reads use \`tail -n +<N>\` to skip already-read lines.` : null,
        '',
        '**What to do next:**',
        '- The agent is now resuming work. Run `sleep 30` and then check status.',
        `- To check status, read the MCP resource \`task:///${taskId}\` — it will show current progress, output, and whether the agent needs further input.`,
        task.outputFilePath ? `- For a quick progress check without reading the full resource, run \`wc -l ${task.outputFilePath}\` — a growing line count means the agent is still working.` : null,
        '- If the agent is still running after your first check, wait longer before checking again: `sleep 60`, then `sleep 90`, `sleep 120`, `sleep 150`, up to `sleep 180` max.',
      ];
      return mcpText(successParts.filter(Boolean).join('\n'));
    }

    // Single-answer path
    const result = questionRegistry.submitAnswer(taskId, parsed.answer!);

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
          parts.push('**Custom answer:** `OTHER: your answer here`');
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
      task.outputFilePath ? `read logs: \`cat -n ${task.outputFilePath}\`` : null,
      task.outputFilePath ? `Use \`cat -n\` to read with line numbers, then on subsequent reads use \`tail -n +<N>\` to skip already-read lines.` : null,
      '',
      '**What to do next:**',
      '- The agent is now resuming work. Run `sleep 30` and then check status.',
      `- To check status, read the MCP resource \`task:///${taskId}\` — it will show current progress, output, and whether the agent needs further input.`,
      task.outputFilePath ? `- For a quick progress check without reading the full resource, run \`wc -l ${task.outputFilePath}\` — a growing line count means the agent is still working.` : null,
      '- If the agent is still running after your first check, wait longer before checking again: `sleep 60`, then `sleep 90`, `sleep 120`, `sleep 150`, up to `sleep 180` max.',
    ];

    return mcpText(parts.filter(Boolean).join('\n'));

  } catch (error) {
    if (error instanceof z.ZodError) {
      return mcpError('Invalid input', 'Required: task_id (string) + either answer (string) or answers (object mapping question IDs to answer strings)');
    }
    return mcpError(
      error instanceof Error ? error.message : 'Unknown error',
      'Check task_id is valid and task has a pending question.'
    );
  }
}
