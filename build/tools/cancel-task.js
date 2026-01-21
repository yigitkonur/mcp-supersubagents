import { CancelTaskSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
export const cancelTaskTool = {
    name: 'cancel_task',
    description: 'Cancel a running Copilot CLI task by its ID',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: 'The task ID to cancel',
            },
        },
        required: ['taskId'],
    },
};
export async function handleCancelTask(args) {
    try {
        const parsed = CancelTaskSchema.parse(args);
        const task = taskManager.getTask(parsed.taskId);
        if (!task) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Task not found: ${parsed.taskId}`,
                        }, null, 2),
                    },
                ],
            };
        }
        const cancelled = taskManager.cancelTask(parsed.taskId);
        if (cancelled) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            taskId: parsed.taskId,
                            message: 'Task cancelled successfully',
                        }, null, 2),
                    },
                ],
            };
        }
        else {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            taskId: parsed.taskId,
                            error: `Task cannot be cancelled (status: ${task.status})`,
                        }, null, 2),
                    },
                ],
            };
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        error: message,
                    }, null, 2),
                },
            ],
        };
    }
}
//# sourceMappingURL=cancel-task.js.map