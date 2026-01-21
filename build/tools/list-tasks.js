import { ListTasksSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
export const listTasksTool = {
    name: 'list_tasks',
    description: 'List all tasks with status. Filter: pending | running | completed | failed',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
        },
        required: [],
    },
};
export async function handleListTasks(args) {
    try {
        const parsed = ListTasksSchema.parse(args || {});
        const tasks = taskManager.getAllTasks(parsed.status);
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        count: tasks.length,
                        tasks: tasks.map(t => ({
                            task_id: t.id,
                            status: t.status,
                            session_id: t.sessionId,
                        })),
                    }),
                }],
        };
    }
    catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
    }
}
//# sourceMappingURL=list-tasks.js.map