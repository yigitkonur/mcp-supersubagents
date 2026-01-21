import { SpawnTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotProcess } from '../services/process-spawner.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { TASK_TYPE_IDS, applyTemplate, isValidTaskType } from '../templates/index.js';
export const spawnTaskTool = {
    name: 'spawn_task',
    description: `Execute a task using GitHub Copilot CLI subagent. Returns task_id for polling.

Models: ${MODEL_IDS.map(m => m === DEFAULT_MODEL ? `${m} (default)` : m).join(' | ')}
Templates: ${TASK_TYPE_IDS.join(' | ')}`,
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'Task description. Be specific: include paths, requirements, expected output.',
            },
            task_type: {
                type: 'string',
                enum: TASK_TYPE_IDS,
                description: 'Agent template (optional)',
            },
            model: {
                type: 'string',
                enum: MODEL_IDS,
                description: 'Model override (optional)',
            },
            cwd: {
                type: 'string',
                description: 'Working directory',
            },
            timeout: {
                type: 'number',
                description: 'Timeout ms (default 300000)',
            },
            autonomous: {
                type: 'boolean',
                description: 'No user prompts (default true)',
            },
        },
        required: ['prompt'],
    },
};
export async function handleSpawnTask(args) {
    try {
        const parsed = SpawnTaskSchema.parse(args);
        let finalPrompt = parsed.prompt;
        if (parsed.task_type && isValidTaskType(parsed.task_type)) {
            finalPrompt = applyTemplate(parsed.task_type, parsed.prompt);
        }
        const taskId = await spawnCopilotProcess({
            prompt: finalPrompt,
            timeout: parsed.timeout,
            cwd: parsed.cwd,
            model: parsed.model,
            autonomous: parsed.autonomous,
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({ task_id: taskId }) }],
        };
    }
    catch (error) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        };
    }
}
//# sourceMappingURL=spawn-task.js.map