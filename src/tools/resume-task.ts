import { ResumeTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { mcpText, formatError, join } from '../utils/format.js';

export const resumeTaskTool = {
  name: 'resume_task',
  description: `Resume an interrupted Copilot session. Get session_id from get_status response.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID from previous task.'
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Auto-detected if omitted.'
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 600000.'
      },
    },
    required: ['session_id'],
  },
};

export async function handleResumeTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const input = args as any;
    const parsed = ResumeTaskSchema.parse({ sessionId: input?.session_id || input?.sessionId, ...input });

    const taskId = await spawnCopilotProcess({
      prompt: '',
      timeout: parsed.timeout,
      cwd: parsed.cwd,
      autonomous: parsed.autonomous,
      resumeSessionId: parsed.sessionId,
    });

    return mcpText(join(
      `Session \`${parsed.sessionId}\` resumed as task **${taskId}**.`,
      'Check status with `get_status`.'
    ));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown',
      'Get `session_id` from a completed or failed task using `get_status` before resuming.'
    ));
  }
}
