/**
 * Template loader for Copilot CLI tasks
 * Templates provide system prompts for different agent types
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TASK_TYPES = {
  executor: 'General executor - implements features, fixes bugs, refactors code',
  researcher: 'Research agent - multi-source research using web, GitHub, Reddit',
  'codebase-researcher': 'Codebase researcher - finds code using semantic search',
  'bug-researcher': 'Bug investigator - deep root cause analysis',
  architect: 'Architecture designer - system design for projects',
  planner: 'Implementation planner - breaks features into tasks',
  turkish: 'Turkish language - always responds in Turkish',
} as const;

export type TaskType = keyof typeof TASK_TYPES;

export const TASK_TYPE_IDS = Object.keys(TASK_TYPES) as TaskType[];

const templateCache = new Map<TaskType, string>();

/**
 * Load template content from .mdx file
 */
export function loadTemplate(taskType: TaskType): string {
  if (templateCache.has(taskType)) {
    return templateCache.get(taskType)!;
  }

  const templatePath = join(__dirname, `${taskType}.mdx`);
  
  try {
    const content = readFileSync(templatePath, 'utf8');
    templateCache.set(taskType, content);
    return content;
  } catch (error) {
    throw new Error(`Template not found: ${taskType}`);
  }
}

/**
 * Check if task type is valid
 */
export function isValidTaskType(type: string): type is TaskType {
  return type in TASK_TYPES;
}

/**
 * Get task type description
 */
export function getTaskTypeDescription(type: TaskType): string {
  return TASK_TYPES[type];
}

/**
 * Format task types for tool description
 */
export function formatTaskTypesForDescription(): string {
  return Object.entries(TASK_TYPES)
    .map(([id, desc]) => `**${id}**: ${desc}`)
    .join('\n');
}

/**
 * Combine template with user prompt
 */
export function applyTemplate(taskType: TaskType, userPrompt: string): string {
  const template = loadTemplate(taskType);
  
  // Replace {{user_prompt}} placeholder with actual prompt
  if (template.includes('{{user_prompt}}')) {
    return template.replace('{{user_prompt}}', userPrompt);
  }
  
  // If no placeholder, prepend template to prompt
  return `${template}\n\n---\n\n**YOUR TASK:**\n${userPrompt}`;
}
