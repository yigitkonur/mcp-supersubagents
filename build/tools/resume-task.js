import { ResumeTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
export const resumeTaskTool = {
    name: 'resume_task',
    description: 'Resume a previous session by session_id (from get_status response).',
    inputSchema: {
        type: 'object',
        properties: {
            session_id: { type: 'string', description: 'Session ID to resume' },
            cwd: { type: 'string', description: 'Working directory' },
            timeout: { type: 'number', description: 'Timeout ms' },
        },
        required: ['session_id'],
    },
};
export async function handleResumeTask(args) {
    try {
        const input = args;
        const parsed = ResumeTaskSchema.parse({ sessionId: input?.session_id || input?.sessionId, ...input });
        const taskId = await spawnCopilotProcess({
            prompt: '',
            timeout: parsed.timeout,
            cwd: parsed.cwd,
            autonomous: parsed.autonomous,
            resumeSessionId: parsed.sessionId,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ task_id: taskId, resumed_session: parsed.sessionId }) }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
    }
}
//# sourceMappingURL=resume-task.js.map