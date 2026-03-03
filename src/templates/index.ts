import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TASK_TYPES = {
  'super-coder': 'super coder for all coding tasks',
  'super-planner': 'super planner for all planning tasks',
  'super-researcher': 'super researcher for answering any question',
  'super-tester': 'super tester to test stuff properly',
  'super-general': 'general-purpose agent for non-code tasks',
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
 * Template resolution:
 *   base template (super-coder.mdx) + user prompt (injected at {{user_prompt}})
 *
 * Agents load domain-specific context at runtime via search-skills + get-skill-details MCP tools.
 * The specialization parameter is accepted for backward compatibility but ignored.
 *
 * When MCP_ENABLED_TOOLS is set, TOOLKIT table rows are filtered to only show enabled tools.
 */
export function applyTemplate(taskType: TaskType, userPrompt: string, _specialization?: string): string {
  const basePath = join(__dirname, `${taskType}.mdx`);
  const base = loadFile(basePath);
  if (!base) return userPrompt;

  let combined = base;

  // Apply tool filtering if MCP_ENABLED_TOOLS is set
  const enabledTools = getEnabledTools();
  if (enabledTools) {
    combined = filterToolkitSection(combined, enabledTools);
  }

  // Inject user prompt
  return combined.includes('{{user_prompt}}')
    ? combined.replace('{{user_prompt}}', () => userPrompt)
    : `${combined}\n\n---\n\n${userPrompt}`;
}
