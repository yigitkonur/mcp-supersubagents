import { ResumeTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';

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

    return { 
      content: [{ 
        type: 'text', 
        text: JSON.stringify({ 
          task_id: taskId, 
          resumed_session: parsed.sessionId,
          next_action: 'get_status',
          next_action_args: { task_id: taskId }
        }) 
      }] 
    };
  } catch (error) {
    return { 
      content: [{ 
        type: 'text', 
        text: JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Unknown',
          suggested_action: 'get_status',
          suggestion: 'Get session_id from completed/failed task before resuming'
        }) 
      }] 
    };
  }
}
