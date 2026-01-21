import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';
// Retry timing configuration (exponential backoff)
const RETRY_INTERVALS = [30, 60, 120, 180]; // seconds: 30s -> 1m -> 2m -> 3m (then stick with 3m)
function getRetryHint(task, checkCount) {
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED) {
        return undefined;
    }
    const intervalIndex = Math.min(checkCount, RETRY_INTERVALS.length - 1);
    const waitSeconds = RETRY_INTERVALS[intervalIndex];
    if (task.status === TaskStatus.PENDING) {
        return `Task is queued. Retry in ${waitSeconds} seconds.`;
    }
    return `Task is running. Retry in ${waitSeconds} seconds.`;
}
export const getTaskStatusTool = {
    name: 'get_status',
    description: `Check task status. Returns status, output, session_id, exit_code, and retry hints.

**IMPORTANT - Avoid Excessive Polling:**
- For running/pending tasks, response includes "retry_after_seconds"
- Backoff: 30s → 60s → 120s → 180s (then stays at 180s)
- Only poll again after the suggested wait time

**Supports batch checking:** Pass array of task_ids to check multiple tasks at once.

**Task IDs are case-insensitive** - "Brave-Tiger-42" equals "brave-tiger-42"`,
    inputSchema: {
        type: 'object',
        properties: {
            task_id: {
                oneOf: [
                    { type: 'string', description: 'Single task ID' },
                    { type: 'array', items: { type: 'string' }, description: 'Array of task IDs to check' },
                ],
                description: 'Task ID(s) from spawn_task - can be a single ID or array of IDs',
            },
        },
        required: ['task_id'],
    },
};
// Track check counts per task for exponential backoff
const taskCheckCounts = new Map();
function getTaskStatus(taskId) {
    const normalizedId = taskId.toLowerCase().trim();
    const task = taskManager.getTask(normalizedId);
    if (!task) {
        return { task_id: taskId, status: 'not_found', error: 'Task not found' };
    }
    // Increment check count for this task
    const checkCount = (taskCheckCounts.get(normalizedId) || 0) + 1;
    taskCheckCounts.set(normalizedId, checkCount);
    // Clean up check counts for completed tasks
    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED || task.status === TaskStatus.CANCELLED) {
        taskCheckCounts.delete(normalizedId);
    }
    const output = task.output.join('\n');
    const result = {
        task_id: task.id,
        status: task.status,
        session_id: task.sessionId || undefined,
        exit_code: task.exitCode,
        output: output.length > 50000 ? output.slice(-50000) : output,
    };
    // Add retry hints for non-terminal states
    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.RUNNING) {
        const intervalIndex = Math.min(checkCount - 1, RETRY_INTERVALS.length - 1);
        result.retry_after_seconds = RETRY_INTERVALS[intervalIndex];
        result.retry_hint = getRetryHint(task, checkCount - 1);
    }
    return result;
}
export async function handleGetTaskStatus(args) {
    try {
        const rawTaskId = args?.task_id || args?.taskId;
        // Handle array of task IDs
        if (Array.isArray(rawTaskId)) {
            const results = rawTaskId.map(id => getTaskStatus(String(id)));
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ tasks: results }),
                    }],
            };
        }
        // Handle single task ID
        const result = getTaskStatus(String(rawTaskId));
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify(result),
                }],
        };
    }
    catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown' }) }] };
    }
}
//# sourceMappingURL=get-status.js.map