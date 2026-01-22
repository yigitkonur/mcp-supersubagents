import { ListTasksSchema } from '../utils/sanitize.js';
import { taskManager } from '../services/task-manager.js';
import { TaskStatus } from '../types.js';

export const listTasksTool = {
  name: 'list_tasks',
  description: `List all spawned tasks with their current status.

**Filter by status:** pending | waiting | running | completed | failed | cancelled | rate_limited | timed_out

**Use cases:**
- Check which tasks are still running before spawning new ones
- Find task IDs you may have lost
- Monitor multiple concurrent tasks
- Check rate-limited tasks queued for auto-retry
- Check waiting tasks blocked on dependencies
- Check timed out tasks that exceeded their timeout

**Response includes:** count, tasks[], next_action (either 'get_status' or 'spawn_task'), next_action_hint`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: { 
        type: 'string', 
        enum: ['pending', 'waiting', 'running', 'completed', 'failed', 'cancelled', 'rate_limited', 'timed_out'],
        description: 'Filter tasks by status. Optional - omit to list all tasks.',
      },
      label: {
        type: 'string',
        description: 'Filter tasks by label. Only tasks with this label will be returned.',
      },
    },
    required: [],
  },
};

export async function handleListTasks(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = ListTasksSchema.parse(args || {});
    const allTasks = taskManager.getAllTasks();
    
    let filtered = allTasks;
    
    // Filter by status if provided
    if (parsed.status) {
      filtered = filtered.filter(t => t.status === parsed.status);
    }
    
    // Filter by label if provided
    if (parsed.label) {
      filtered = filtered.filter(t => t.labels?.includes(parsed.label!));
    }

    const tasks = filtered.map(t => {
      const taskInfo: Record<string, unknown> = {
        task_id: t.id,
        status: t.status,
        session_id: t.sessionId || undefined,
      };
      
      // Add retry info for rate-limited tasks
      if (t.status === TaskStatus.RATE_LIMITED && t.retryInfo) {
        taskInfo.retry_count = t.retryInfo.retryCount;
        taskInfo.next_retry = t.retryInfo.nextRetryTime;
        taskInfo.will_auto_retry = t.retryInfo.retryCount < t.retryInfo.maxRetries;
      }
      
      // Add dependency info for waiting tasks
      if (t.dependsOn && t.dependsOn.length > 0) {
        taskInfo.depends_on = t.dependsOn;
        if (t.status === TaskStatus.WAITING) {
          const depStatus = taskManager.getDependencyStatus(t.id);
          if (depStatus) {
            taskInfo.deps_pending = depStatus.pending;
            taskInfo.deps_failed = depStatus.failed.length > 0 ? depStatus.failed : undefined;
          }
        }
      }
      
      // Add labels if present
      if (t.labels && t.labels.length > 0) {
        taskInfo.labels = t.labels;
      }
      
      return taskInfo;
    });

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
          suggestion: 'Check status filter is valid: pending, running, completed, failed, cancelled, rate_limited'
        }) 
      }] 
    };
  }
}
