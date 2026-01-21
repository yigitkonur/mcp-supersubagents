import { ResumeTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';

export const resumeTaskTool = {
  name: 'resume_task',
  description: `Resume a previously interrupted Copilot session using its session_id.

**When to use:** If a task was interrupted or you need to continue where it left off, use this to resume from the exact state.

**Getting session_id:** Call get_status on a completed/failed task - the response includes session_id if the session can be resumed.

**After resuming:** Use get_status with the returned task_id to monitor progress. Follow retry_after_seconds guidance.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { 
        type: 'string', 
        description: 'Session ID from a previous task (found in get_status response).' 
      },
      cwd: { 
        type: 'string', 
        description: 'Working directory. Optional - auto-detected from client workspace.' 
      },
      timeout: { 
        type: 'number', 
        description: 'Max execution time in ms. Optional, defaults to 600000 (10 minutes). Max 1 hour.' 
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
          resumed_session: parsed.sessionId
        }) 
      }] 
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
  }
}
