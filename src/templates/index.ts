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

/**
 * Parse MCP_ENABLED_TOOLS env var.
 * When set (comma-separated), only matching tool rows in TOOLKIT tables are kept.
 * Example: MCP_ENABLED_TOOLS=playwright-cli,warpgrep_codebase_search,bash
 * Returns null when unset (meaning all tools enabled).
 */
function getEnabledTools(): Set<string> | null {
  const raw = process.env.MCP_ENABLED_TOOLS;
  if (!raw) return null;
  return new Set(raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
}

/**
 * Filter TOOLKIT table rows based on MCP_ENABLED_TOOLS.
 * Matches tool names in backticks at the start of table cells: | `tool_name` |
 * Always keeps the header row and separator row.
 * Also keeps non-table content untouched.
 */
function filterToolkitSection(content: string, enabledTools: Set<string>): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inToolkitTable = false;
  let headerRowsPassed = 0;

  for (const line of lines) {
    // Detect toolkit table by looking for rows starting with | and containing backtick-wrapped tool names
    const isTableRow = line.trimStart().startsWith('|') && line.trimEnd().endsWith('|');

    if (isTableRow) {
      // Check if this is a header or separator row
      const isSeparator = /^\s*\|[\s-:|]+\|\s*$/.test(line);
      const isHeader = headerRowsPassed === 0 && !isSeparator;

      if (isHeader) {
        // Check if this looks like a TOOLKIT table (has Tool/Purpose-like headers)
        if (/\bTool\b/i.test(line) || /\bPurpose\b/i.test(line) || /\bWhen\b/i.test(line)) {
          inToolkitTable = true;
          headerRowsPassed = 1;
          result.push(line);
          continue;
        }
      }

      if (inToolkitTable) {
        if (isSeparator) {
          headerRowsPassed++;
          result.push(line);
          continue;
        }

        // Extract tool name from backticks in the first cell
        const toolMatch = line.match(/\|\s*`([^`]+)`/);
        if (toolMatch) {
          const toolName = toolMatch[1].toLowerCase().split(/\s/)[0]; // first word only
          if (enabledTools.has(toolName) || enabledTools.has(toolName.replace(/_/g, '-'))) {
            result.push(line);
          }
          // Skip if not in enabled list
          continue;
        }

        // Non-backtick table row in toolkit section — keep it
        result.push(line);
        continue;
      }
    } else {
      // Non-table row: reset toolkit table tracking
      if (inToolkitTable && !isTableRow) {
        inToolkitTable = false;
        headerRowsPassed = 0;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

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
 *
 * When MCP_ENABLED_TOOLS is set, TOOLKIT table rows are filtered to only show enabled tools.
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
    // Fallback: try bare {specialization}.mdx (cross-role overlays like arabic-answer)
    overlay = loadFile(overlayPath) || loadFile(join(__dirname, 'overlays', `${specialization}.mdx`)) || '';
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

  // Apply tool filtering if MCP_ENABLED_TOOLS is set
  const enabledTools = getEnabledTools();
  if (enabledTools) {
    combined = filterToolkitSection(combined, enabledTools);
  }

  // Inject user prompt
  return combined.includes('{{user_prompt}}')
    ? combined.replace('{{user_prompt}}', userPrompt)
    : `${combined}\n\n---\n\n${userPrompt}`;
}
