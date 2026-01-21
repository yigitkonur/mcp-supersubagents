import { GetTaskStatusSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
export const getTaskStatusTool = {
    name: 'get_status',
    description: 'Poll task status and output. Returns: status, output, session_id, exit_code.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: 'Task ID from spawn_task' },
        },
        required: ['task_id'],
    },
};
export async function handleGetTaskStatus(args) {
    try {
        const parsed = GetTaskStatusSchema.parse({ taskId: args?.task_id || args?.taskId });
        const task = taskManager.getTask(parsed.taskId);
        if (!task) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'Task not found' }) }] };
        }
        const output = task.output.join('\n');
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        task_id: task.id,
                        status: task.status,
                        session_id: task.sessionId,
                        exit_code: task.exitCode,
                        output: output.length > 50000 ? output.slice(-50000) : output,
                    }),
                }],
        };
    }
    catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
    }
}
//# sourceMappingURL=get-status.js.map