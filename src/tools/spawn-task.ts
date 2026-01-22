import { SpawnTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { taskManager } from '../services/task-manager.js';
import { MODEL_IDS, MODELS, DEFAULT_MODEL } from '../models.js';
import { TASK_TYPE_IDS, TASK_TYPES, applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';

export const spawnTaskTool = {
  name: 'spawn_task',
  description: `Execute a task using GitHub Copilot CLI agent. Returns a human-readable task_id for tracking.

**Quick Start:** Only "prompt" is required. Everything else has sensible defaults.

**Task Types (pick one that matches your goal):**
- **super-coder**: Implementation tasks - writing code, fixing bugs, refactoring
- **super-planner**: Architecture and planning - design decisions, breaking down complex work
- **super-researcher**: Investigation tasks - codebase exploration, understanding systems
- **super-tester**: Testing tasks - writing tests, QA verification

**Models:** ${MODEL_IDS.map(m => m === DEFAULT_MODEL ? `${m} (default)` : m).join(', ')}

**Response includes:** task_id, next_action='get_status', next_action_args={task_id}`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'What should the agent do? Be specific: include file paths, requirements, and expected outcomes.',
      },
      task_type: {
        type: 'string',
        enum: TASK_TYPE_IDS,
        description: 'Agent template optimizing for specific task types. Optional - omit for general tasks.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `AI model to use. Optional, defaults to ${DEFAULT_MODEL}.`,
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Optional - auto-detected from client workspace.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Optional, defaults to 600000 (10 minutes). Max 1 hour.',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without user prompts. Optional, defaults to true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional array of task IDs this task depends on. Task will wait until all dependencies complete successfully before running.',
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
        return {
          content: [{ type: 'text', text: JSON.stringify({ 
            error: validationError,
            suggested_action: 'list_tasks',
            suggestion: 'Ensure all dependency task IDs exist before creating dependent task'
          }) }],
        };
      }
    }
    
    let finalPrompt = parsed.prompt;
    if (parsed.task_type && isValidTaskType(parsed.task_type)) {
      finalPrompt = applyTemplate(parsed.task_type as TaskType, parsed.prompt);
    }
    
    const taskId = await spawnCopilotProcess({
      prompt: finalPrompt,
      timeout: parsed.timeout,
      cwd: parsed.cwd,
      model: parsed.model,
      autonomous: parsed.autonomous,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    });

    const task = taskManager.getTask(taskId);
    const isWaiting = task?.status === 'waiting';

    return {
      content: [{ type: 'text', text: JSON.stringify({ 
        task_id: taskId,
        status: task?.status || 'pending',
        depends_on: dependsOn.length > 0 ? dependsOn : undefined,
        message: isWaiting ? `Task queued, waiting for dependencies: ${dependsOn.join(', ')}` : undefined,
        next_action: 'get_status',
        next_action_args: { task_id: taskId }
      }) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        suggested_action: 'spawn_task',
        suggestion: 'Check prompt parameter is provided and valid'
      }) }],
    };
  }
}
