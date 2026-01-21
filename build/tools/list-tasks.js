import { ListTasksSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
export const listTasksTool = {
    name: 'list_tasks',
    description: `List all spawned tasks with their current status.

**Filter by status:** pending | running | completed | failed | cancelled

**Use cases:**
- Check which tasks are still running before spawning new ones
- Find task IDs you may have lost
- Monitor multiple concurrent tasks

**Tip:** Use get_status with an array of task_ids for detailed status of specific tasks.`,
    inputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
                description: 'Filter tasks by status. Optional - omit to list all tasks.',
            },
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