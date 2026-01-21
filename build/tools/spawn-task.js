import { SpawnTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { MODEL_IDS, CLAUDE_MODELS, DEFAULT_MODEL } from '../models.js';
import { TASK_TYPE_IDS, TASK_TYPES, applyTemplate, isValidTaskType } from '../templates/index.js';
const modelDescriptions = Object.entries(CLAUDE_MODELS)
    .map(([id, desc]) => `**${id}**: ${desc}`)
    .join('\n');
const taskTypeDescriptions = Object.entries(TASK_TYPES)
    .map(([id, desc]) => `**${id}**: ${desc}`)
    .join('\n');
export const spawnTaskTool = {
    name: 'spawn_copilot_task',
    description: `Spawn a GitHub Copilot CLI subagent task. Returns task ID for polling with get_task_status.

**Models (Claude only):**
${modelDescriptions}

**Task Types (optional templates):**
${taskTypeDescriptions}

Default model: ${DEFAULT_MODEL}`,
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The task prompt. Be specific and detailed. Include file paths, requirements, and expected outcomes.',
            },
            task_type: {
                type: 'string',
                enum: TASK_TYPE_IDS,
                description: 'Optional agent template: executor, researcher, codebase-researcher, bug-researcher, architect, planner',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in ms (default: 300000 = 5 min, max: 3600000 = 1 hour).',
            },
            cwd: {
                type: 'string',
                description: 'Working directory for task execution.',
            },
            model: {
                type: 'string',
                enum: MODEL_IDS,
                description: 'Claude model: claude-sonnet-4 (default), claude-sonnet-4.5, claude-haiku-4.5, claude-opus-4.5',
            },
            silent: {
                type: 'boolean',
                description: 'Output only response without stats (default: true).',
            },
            autonomous: {
                type: 'boolean',
                description: 'Run without user prompts (default: false). Use --no-ask-user flag.',
            },
        },
        required: ['prompt'],
    },
};
export async function handleSpawnTask(args) {
    try {
        const parsed = SpawnTaskSchema.parse(args);
        // Apply template if task_type is specified
        let finalPrompt = parsed.prompt;
        if (parsed.task_type && isValidTaskType(parsed.task_type)) {
            finalPrompt = applyTemplate(parsed.task_type, parsed.prompt);
        }
        const taskId = await spawnCopilotProcess({
            prompt: finalPrompt,
            timeout: parsed.timeout,
            cwd: parsed.cwd,
            model: parsed.model,
            silent: parsed.silent,
            autonomous: parsed.autonomous,
        });
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        taskId,
                        message: 'Task spawned successfully. Use get_task_status to check progress.',
                    }, null, 2),
                },
            ],
        };
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
//# sourceMappingURL=spawn-task.js.map