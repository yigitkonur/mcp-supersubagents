import { z } from 'zod';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { taskManager } from '../services/task-manager.js';
import { MODEL_IDS } from '../models.js';
import { TASK_TYPE_IDS, applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';
import { progressRegistry } from '../services/progress-registry.js';
import type { ToolContext } from '../types.js';
import { mcpText, formatError, formatTable, join } from '../utils/format.js';

const TaskDefinitionSchema = z.object({
  id: z.string().min(1).describe('Local reference ID for this task (used in depends_on)'),
  prompt: z.string().min(1).max(50000),
  task_type: z.enum(TASK_TYPE_IDS as [string, ...string[]]).optional(),
  model: z.enum(MODEL_IDS as [string, ...string[]]).optional(),
  depends_on: z.array(z.string()).optional().describe('Array of local IDs from this batch'),
  labels: z.array(z.string().min(1).max(50)).max(10).optional().describe('Optional labels for filtering'),
});

const BatchSpawnSchema = z.object({
  tasks: z.array(TaskDefinitionSchema).min(1).max(20),
  cwd: z.string().optional(),
  autonomous: z.boolean().optional().default(true),
});

export const batchSpawnTool = {
  name: 'batch_spawn',
  description: `Create multiple tasks with dependency chains in ONE atomic call.

WHEN TO USE: Only when you have 2+ small, well-defined tasks that have explicit cross-dependencies and must be set up together (e.g. "build step" -> "test step" -> "deploy step"). This is for DAG-style pipelines where task B literally cannot start until task A completes.

WHEN NOT TO USE (prefer spawn_task instead):
- For independent tasks with no dependencies -- just call spawn_task multiple times
- For complex tasks that need detailed, unique prompts -- spawn_task lets you craft each prompt individually
- For most work -- individual spawn_task calls give you better control and produce better results
- When tasks are large or nuanced -- batch prompts tend to be rushed and vague

Each task in the batch still runs as an isolated agent with NO shared context. Every prompt must be fully self-contained with all file paths, context, and instructions -- just like spawn_task.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Local ID used to reference this task in depends_on of other tasks within this batch.' },
            prompt: {
              type: 'string',
              description: `Complete, self-contained instructions for this agent. Same rules as spawn_task: the agent has NO conversation history or shared context. Include all file paths (absolute), full context, and success criteria. Do NOT write vague one-liners -- each task needs a detailed brief.`,
            },
            task_type: { type: 'string', enum: TASK_TYPE_IDS, description: 'Agent template: super-coder, super-planner, super-researcher, or super-tester.' },
            model: { type: 'string', enum: MODEL_IDS, description: 'Model override for this specific task.' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Local IDs (from this batch) or existing task IDs that must complete first. Dependencies must appear earlier in the array.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Labels for filtering (max 10).' },
          },
          required: ['id', 'prompt'],
        },
        description: 'Task definitions in dependency order (max 20). Tasks listed first can be depended on by tasks listed later.',
        minItems: 1,
        maxItems: 20,
      },
      cwd: {
        type: 'string',
        description: `Shared working directory for ALL tasks in this batch. Pass the absolute path to your current working directory. For git worktrees, pass the actual worktree path, not the main repo root.`,
      },
      autonomous: { type: 'boolean', description: 'Run without prompts. Default: true.' },
    },
    required: ['tasks'],
  },
};

interface CreatedTask {
  local_id: string;
  task_id: string;
  status: string;
  depends_on?: string[];
}

export async function handleBatchSpawn(args: unknown, ctx?: ToolContext): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = BatchSpawnSchema.parse(args);

    // Validate no duplicate local IDs
    const localIds = parsed.tasks.map(t => t.id);
    const duplicates = localIds.filter((id, i) => localIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      return mcpText(formatError(
        `Duplicate local IDs: ${[...new Set(duplicates)].join(', ')}`,
        'Each task must have a unique local ID.'
      ));
    }

    // Validate dependency references (must be earlier in array or existing task)
    for (let i = 0; i < parsed.tasks.length; i++) {
      const task = parsed.tasks[i];
      if (task.depends_on) {
        for (const depId of task.depends_on) {
          const depIndex = localIds.indexOf(depId);
          // Must be either an earlier task in batch OR an existing task
          if (depIndex === -1) {
            // Check if it's an existing task
            const existingTask = taskManager.getTask(depId);
            if (!existingTask) {
              return mcpText(formatError(
                `Task '${task.id}' depends on unknown '${depId}'`,
                'Dependencies must reference earlier tasks in batch or existing task IDs.'
              ));
            }
          } else if (depIndex >= i) {
            return mcpText(formatError(
              `Task '${task.id}' depends on '${depId}' which comes later in the batch`,
              'Reorder tasks so dependencies come before dependents.'
            ));
          }
        }
      }
    }

    // Create tasks in order, mapping local IDs to real task IDs
    const idMap = new Map<string, string>();
    const createdTasks: CreatedTask[] = [];

    for (const taskDef of parsed.tasks) {
      // Resolve depends_on from local IDs to real task IDs
      let realDependsOn: string[] | undefined;
      if (taskDef.depends_on && taskDef.depends_on.length > 0) {
        realDependsOn = taskDef.depends_on.map(localId => {
          // Check if it's a local ID we've created
          const mappedId = idMap.get(localId);
          if (mappedId) return mappedId;
          // Otherwise it must be an existing task ID
          return localId;
        });
      }

      // Apply template if specified
      let finalPrompt = taskDef.prompt;
      if (taskDef.task_type && isValidTaskType(taskDef.task_type)) {
        finalPrompt = applyTemplate(taskDef.task_type as TaskType, taskDef.prompt);
      }

      // Spawn the task
      const labels = taskDef.labels?.filter(l => l.trim()) || [];
      const taskId = await spawnCopilotProcess({
        prompt: finalPrompt,
        cwd: parsed.cwd,
        model: taskDef.model,
        autonomous: parsed.autonomous,
        dependsOn: realDependsOn,
        labels: labels.length > 0 ? labels : undefined,
      });

      // Map local ID to real task ID
      idMap.set(taskDef.id, taskId);


      if (ctx?.progressToken != null) {
        progressRegistry.register(taskId, ctx.progressToken, ctx.sendNotification);
        progressRegistry.sendProgress(taskId, `Batch task ${createdTasks.length + 1}/${parsed.tasks.length}: ${taskDef.id} → ${taskId}`);
      }


      const task = taskManager.getTask(taskId);
      createdTasks.push({
        local_id: taskDef.id,
        task_id: taskId,
        status: task?.status || 'pending',
        depends_on: realDependsOn,
      });
    }

    const header = `## Batch Created (${createdTasks.length} tasks)`;
    const rows = createdTasks.map(t => [
      t.local_id,
      `**${t.task_id}**`,
      t.status,
      t.depends_on?.join(', ') || '--',
    ]);
    const table = formatTable(['Local ID', 'Task ID', 'Status', 'Depends On'], rows);

    return mcpText(join(header, '', table, '', 'Check all with `get_status`.'));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Check tasks array format and dependencies.'
    ));
  }
}
