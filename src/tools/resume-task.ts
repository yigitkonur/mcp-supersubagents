import { ResumeTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export const resumeTaskTool = {
  name: 'resume_copilot_task',
  description: `Resume a previous Copilot CLI session using --resume flag.

**Usage:** Get sessionId from get_task_status response, then resume to continue interrupted work.

**Note:** Uses \`copilot --resume <sessionId>\` internally. Session must exist in Copilot's session store.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID from previous task (found in get_task_status sessionId field)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms (default: 300000 = 5 min)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (should match original session)',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without user prompts (default: false)',
      },
    },
    required: ['sessionId'],
  },
};

export async function handleResumeTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ResumeTaskSchema.parse(args);
    
    if (!SESSION_ID_PATTERN.test(parsed.sessionId)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Invalid sessionId format. Expected 8-64 alphanumeric characters.',
          }, null, 2),
        }],
      };
    }
    
    const taskId = await spawnCopilotProcess({
      prompt: '', // Not used for resume
      timeout: parsed.timeout,
      cwd: parsed.cwd,
      autonomous: parsed.autonomous,
      resumeSessionId: parsed.sessionId,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          taskId,
          resumedSessionId: parsed.sessionId,
          message: 'Session resumed. Poll get_task_status for progress.',
        }, null, 2),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: message,
        }, null, 2),
      }],
    };
  }
}
