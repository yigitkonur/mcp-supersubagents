import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TASK_TYPES = {
  'super-coder': 'super coder for all coding tasks',
  'super-planner': 'super planner for all planning tasks',
  'super-researcher': 'super researcher for answering any question',
  'super-tester': 'super tester to test stuff properly',
} as const;

export type TaskType = keyof typeof TASK_TYPES;
export const TASK_TYPE_IDS = Object.keys(TASK_TYPES) as TaskType[];

const templateCache = new Map<string, string>();

export function isValidTaskType(type: string): type is TaskType {
  return type in TASK_TYPES;
}

function loadFile(filePath: string): string | null {
  if (templateCache.has(filePath)) return templateCache.get(filePath)!;
  try {
    const content = readFileSync(filePath, 'utf8');
    templateCache.set(filePath, content);
    return content;
  } catch {
    return null;
  }
}

/**
 * Matryoshka template resolution:
 *   base template (super-coder.mdx)
 *     + specialization overlay (overlays/coder-typescript.mdx)
 *       + user prompt (injected at {{user_prompt}})
 *
 * The overlay is inserted before the "## BEGIN" section of the base template.
 * If no overlay or no BEGIN section, overlay is appended before user prompt injection.
 */
export function applyTemplate(taskType: TaskType, userPrompt: string, specialization?: string): string {
  const basePath = join(__dirname, `${taskType}.mdx`);
  const base = loadFile(basePath);
  if (!base) return userPrompt;

  // Load specialization overlay if requested
  let overlay = '';
  if (specialization) {
    // Map task type to overlay prefix: super-coder -> coder, super-planner -> planner
    const overlayPrefix = taskType.replace('super-', '');
    const overlayPath = join(__dirname, 'overlays', `${overlayPrefix}-${specialization}.mdx`);
    overlay = loadFile(overlayPath) || '';
  }

  // Combine base + overlay
  let combined = base;
  if (overlay) {
    // Insert overlay before the ## BEGIN section for natural reading order
    if (combined.includes('## BEGIN')) {
      combined = combined.replace('## BEGIN', `${overlay}\n\n---\n\n## BEGIN`);
    } else {
      // Fallback: append overlay before user prompt position
      combined = combined.includes('{{user_prompt}}')
        ? combined.replace('{{user_prompt}}', `\n\n${overlay}\n\n---\n\n{{user_prompt}}`)
        : `${combined}\n\n---\n\n${overlay}`;
    }
  }

  // Inject user prompt
  return combined.includes('{{user_prompt}}')
    ? combined.replace('{{user_prompt}}', userPrompt)
    : `${combined}\n\n---\n\n${userPrompt}`;
}
