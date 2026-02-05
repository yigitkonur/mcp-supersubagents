import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TASK_TYPES = {
  'super-coder': 'super coder for all coding tasks',
  'super-planner': 'super planner for all planning tasks',
  'super-researcher': 'super researcher for answering any question',
  'super-tester': 'super tester to test stuff properly',
  'super-arabic': 'Arabic-only agent that writes everything in Arabic',
  'super-questioner': 'agent that always asks the user a question before proceeding',
} as const;

export type TaskType = keyof typeof TASK_TYPES;
export const TASK_TYPE_IDS = Object.keys(TASK_TYPES) as TaskType[];

const cache = new Map<TaskType, string>();

export function isValidTaskType(type: string): type is TaskType {
  return type in TASK_TYPES;
}

export function applyTemplate(taskType: TaskType, userPrompt: string): string {
  if (!cache.has(taskType)) {
    try {
      cache.set(taskType, readFileSync(join(__dirname, `${taskType}.mdx`), 'utf8'));
    } catch {
      return userPrompt;
    }
  }
  const template = cache.get(taskType)!;
  return template.includes('{{user_prompt}}') 
    ? template.replace('{{user_prompt}}', userPrompt) 
    : `${template}\n\n---\n\n${userPrompt}`;
}
