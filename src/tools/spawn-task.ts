import { SpawnTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { taskManager } from '../services/task-manager.js';
import { MODEL_IDS, MODELS, DEFAULT_MODEL } from '../models.js';
import { TASK_TYPE_IDS, TASK_TYPES, applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';
import { mcpText, formatError, join, formatLabels } from '../utils/format.js';

export const spawnTaskTool = {
  name: 'spawn_task',
  description: `Spawn a Copilot CLI agent task. Returns task_id for tracking.

Task types: super-coder (implementation), super-planner (architecture), super-researcher (investigation), super-tester (QA).
Models: ${MODEL_IDS.join(', ')}. Default: ${DEFAULT_MODEL}.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Task instructions. Be specific with file paths and requirements.',
      },
      task_type: {
        type: 'string',
        enum: TASK_TYPE_IDS,
        description: 'Agent template for specific task types.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}.`,
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Auto-detected if omitted.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 600000 (10 min). Max: 3600000.',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without prompts. Default: true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs to wait for before running.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for filtering (max 10).',
      },
    },
    required: ['prompt'],
  },
};

export async function handleSpawnTask(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = SpawnTaskSchema.parse(args);

    // Validate dependencies if provided
    const dependsOn = parsed.depends_on?.filter((d: string) => d.trim()) || [];
    if (dependsOn.length > 0) {
      const validationError = taskManager.validateDependencies(dependsOn);
      if (validationError) {
        return mcpText(formatError(
          validationError,
          'Ensure all dependency task IDs exist.\nUse `list_tasks` to find valid task IDs.'
        ));
      }
    }

    let finalPrompt = parsed.prompt;
    if (parsed.task_type && isValidTaskType(parsed.task_type)) {
      finalPrompt = applyTemplate(parsed.task_type as TaskType, parsed.prompt);
    }

    const labels = parsed.labels?.filter((l: string) => l.trim()) || [];

    const taskId = await spawnCopilotProcess({
      prompt: finalPrompt,
      timeout: parsed.timeout,
      cwd: parsed.cwd,
      model: parsed.model,
      autonomous: parsed.autonomous,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
    });

    const task = taskManager.getTask(taskId);
    const isWaiting = task?.status === 'waiting';

    if (isWaiting) {
      const depsList = dependsOn.map(d => `\`${d}\``).join(', ');
      return mcpText(join(
        `Task **${taskId}** spawned (waiting).`,
        `Depends on: ${depsList}`,
        '',
        'Dependencies must complete before this task runs.',
        'Check status with `get_status`.'
      ));
    }

    return mcpText(join(
      `Task **${taskId}** spawned (${task?.status || 'pending'}).`,
      'Check status with `get_status`.'
    ));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Check that the `prompt` parameter is provided and valid.'
    ));
  }
}
