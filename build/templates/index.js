import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
export const TASK_TYPES = {
    executor: 'General task executor',
    researcher: 'Web/GitHub research',
    'codebase-researcher': 'Codebase search',
    'bug-researcher': 'Bug analysis',
    architect: 'System design',
    planner: 'Task planning',
    turkish: 'Turkish responses',
};
export const TASK_TYPE_IDS = Object.keys(TASK_TYPES);
const cache = new Map();
export function isValidTaskType(type) {
    return type in TASK_TYPES;
}
export function applyTemplate(taskType, userPrompt) {
    if (!cache.has(taskType)) {
        try {
            cache.set(taskType, readFileSync(join(__dirname, `${taskType}.mdx`), 'utf8'));
        }
        catch {
            return userPrompt;
        }
    }
    const template = cache.get(taskType);
    return template.includes('{{user_prompt}}')
        ? template.replace('{{user_prompt}}', userPrompt)
        : `${template}\n\n---\n\n${userPrompt}`;
}
//# sourceMappingURL=index.js.map