import { ListTasksSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

export const listTasksTool = {
  name: 'list_tasks',
  description: `List all spawned tasks with their current status.

**Filter by status:** pending | running | completed | failed | cancelled

**Use cases:**
- Check which tasks are still running before spawning new ones
- Find task IDs you may have lost
- Monitor multiple concurrent tasks

**Response includes:** count, tasks[], next_action (either 'get_status' or 'spawn_task'), next_action_hint`,
  inputSchema: {
    type: 'object' as const,
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

export async function handleListTasks(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ListTasksSchema.parse(args || {});
    const allTasks = taskManager.getAllTasks();
    
    const filtered = parsed.status 
      ? allTasks.filter(t => t.status === parsed.status)
      : allTasks;

    const tasks = filtered.map(t => ({
      task_id: t.id,
      status: t.status,
      session_id: t.sessionId || undefined,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: tasks.length,
          tasks,
          next_action: tasks.length > 0 ? 'get_status' : 'spawn_task',
          next_action_hint: tasks.length > 0 
            ? 'Use get_status with task_id array to check multiple tasks at once'
            : 'No tasks found. Use spawn_task to create one.'
        }),
      }],
    };
  } catch (error) {
    return { 
      content: [{ 
        type: 'text', 
        text: JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Unknown',
          suggested_action: 'list_tasks',
          suggestion: 'Check status filter is valid: pending, running, completed, failed, cancelled'
        }) 
      }] 
    };
  }
}
