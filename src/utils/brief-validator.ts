import { existsSync, accessSync, statSync, readFileSync, constants } from 'fs';
import { extname, isAbsolute } from 'path';

// --- Validation rule types ---

export interface ContextFile {
  path: string;
  description?: string;
}

export interface ValidationError {
  code: string;
  message: string;
  detail?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ToolValidationRules {
  toolName: string;
  minPromptLength: number;
  requireContextFiles: boolean;
  minContextFiles: number;
  requireMdExtension: boolean;
  maxFileSizeBytes: number;
  maxTotalSizeBytes: number;
  briefTemplate: string;
  workflowHint: string;
}

// --- Per-tool validation rules ---

const MAX_FILE_SIZE = 200 * 1024;   // 200KB per file
const MAX_TOTAL_SIZE = 500 * 1024;  // 500KB total

const CODER_RULES: ToolValidationRules = {
  toolName: 'spawn_coder',
  minPromptLength: 1000,
  requireContextFiles: true,
  minContextFiles: 1,
  requireMdExtension: true,
  maxFileSizeBytes: MAX_FILE_SIZE,
  maxTotalSizeBytes: MAX_TOTAL_SIZE,
  briefTemplate: [
    '🎯 OBJECTIVE: [What exactly to build/modify — specific deliverables, not vague goals]',
    '📁 FILES TO MODIFY: [ALL absolute file paths the agent needs to touch]',
    '✅ SUCCESS CRITERIA: [Exactly how to verify the implementation is correct]',
    '🚫 CONSTRAINTS: [What NOT to do — boundaries, forbidden approaches, patterns to avoid]',
    '🔗 PATTERNS TO FOLLOW: [Existing code patterns to match, utilities to reuse]',
    '📝 CONTEXT: [Background — why this matters, dependencies, architectural decisions]',
  ].join('\n'),
  workflowHint: [
    '🔄 RECOMMENDED WORKFLOW:',
    '1. spawn_planner → creates plan at .agent-workspace/plans/[topic]/',
    '2. spawn_coder → reference plan files in context_files',
    '3. spawn_tester → verify the implementation',
    '',
    '📎 REFERENCE FILES FROM OTHER AGENTS:',
    '• Planner output: .agent-workspace/plans/[topic]/05-handoff/builder-briefing.md',
    '• Researcher output: .agent-workspace/researches/[topic]/HANDOFF.md',
  ].join('\n'),
};

const PLANNER_RULES: ToolValidationRules = {
  toolName: 'spawn_planner',
  minPromptLength: 300,
  requireContextFiles: false,
  minContextFiles: 0,
  requireMdExtension: false,
  maxFileSizeBytes: MAX_FILE_SIZE,
  maxTotalSizeBytes: MAX_TOTAL_SIZE,
  briefTemplate: [
    '🎯 PROBLEM STATEMENT: [What needs to be solved — the actual problem, not a solution]',
    '🚫 CONSTRAINTS: [What\'s been ruled out, what must be preserved]',
    '✅ VERIFIED FACTS: [What you already know — don\'t re-investigate these]',
    '📏 SCOPE: [What\'s in/out of scope — be explicit]',
    '📤 EXPECTED OUTPUT: [What the next agent (Coder/Tester) needs from this plan]',
  ].join('\n'),
  workflowHint: [
    '📎 TIP: The planner creates files at .agent-workspace/plans/[topic]/',
    'Use those files as context_files when spawning spawn_coder next.',
  ].join('\n'),
};

const TESTER_RULES: ToolValidationRules = {
  toolName: 'spawn_tester',
  minPromptLength: 300,
  requireContextFiles: true,
  minContextFiles: 1,
  requireMdExtension: false,
  maxFileSizeBytes: MAX_FILE_SIZE,
  maxTotalSizeBytes: MAX_TOTAL_SIZE,
  briefTemplate: [
    '🎯 WHAT WAS BUILT: [Feature/fix to verify — specific deliverable]',
    '📁 FILES CHANGED: [Where to focus testing — absolute paths]',
    '✅ SUCCESS CRITERIA: [What "working" means — specific, testable conditions]',
    '🔍 TEST SUGGESTIONS: [Specific flows to test — happy path + edge cases]',
    '⚠️ EDGE CASES: [What the coder is worried about — potential failure points]',
    '🌐 BASE URL / SETUP: [How to access the system under test]',
  ].join('\n'),
  workflowHint: [
    '📎 REFERENCE FILES FROM OTHER AGENTS:',
    '• Coder handoff: .agent-workspace/implementation/[topic]/HANDOFF.md',
    '• Planner test checklist: .agent-workspace/plans/[topic]/05-handoff/tester-checklist.md',
  ].join('\n'),
};

const RESEARCHER_RULES: ToolValidationRules = {
  toolName: 'spawn_researcher',
  minPromptLength: 200,
  requireContextFiles: false,
  minContextFiles: 0,
  requireMdExtension: false,
  maxFileSizeBytes: MAX_FILE_SIZE,
  maxTotalSizeBytes: MAX_TOTAL_SIZE,
  briefTemplate: [
    '🎯 WHAT TO RESEARCH: [Specific topic or question — not vague "research X"]',
    '🤔 WHY IT MATTERS: [What decision this research informs]',
    '📚 WHAT\'S ALREADY KNOWN: [Don\'t re-research verified facts]',
    '❓ SPECIFIC QUESTIONS: [2-5 pointed, answerable questions]',
    '📤 HANDOFF TARGET: [Who reads the output — Planner? Coder? Human?]',
  ].join('\n'),
  workflowHint: [
    '📎 TIP: Research output goes to .agent-workspace/researches/[topic]/HANDOFF.md',
    'Reference this file when spawning spawn_planner or spawn_coder next.',
  ].join('\n'),
};

export const VALIDATION_RULES: Record<string, ToolValidationRules> = {
  'spawn_coder': CODER_RULES,
  'spawn_planner': PLANNER_RULES,
  'spawn_tester': TESTER_RULES,
  'spawn_researcher': RESEARCHER_RULES,
};

// --- Validation functions ---

export function validateBrief(
  toolName: string,
  prompt: string,
  contextFiles?: ContextFile[],
): ValidationResult {
  const rules = VALIDATION_RULES[toolName];
  if (!rules) return { valid: true, errors: [] };

  const errors: ValidationError[] = [];

  // 1. Prompt length check
  if (prompt.length < rules.minPromptLength) {
    errors.push({
      code: 'PROMPT_TOO_SHORT',
      message: `PROMPT TOO SHORT: ${prompt.length} characters (MINIMUM: ${rules.minPromptLength})`,
      detail: `Your prompt MUST include these sections:\n${rules.briefTemplate}`,
    });
  }

  // 2. Context files required check
  const files = contextFiles || [];
  if (rules.requireContextFiles && files.length < rules.minContextFiles) {
    errors.push({
      code: 'MISSING_CONTEXT_FILES',
      message: `MISSING CONTEXT FILES: ${rules.toolName} REQUIRES at least ${rules.minContextFiles} file(s)`,
      detail: rules.requireMdExtension
        ? 'Attach Markdown files (.md) — plan documents, specifications, or research findings.\nEach file must have an absolute path ending with .md'
        : 'Attach relevant files — code, handoff documents, or specifications.\nEach file must have an absolute path.',
    });
  }

  // 3. Validate each context file
  let totalSize = 0;
  for (const file of files) {
    // Absolute path check
    if (!isAbsolute(file.path)) {
      errors.push({
        code: 'RELATIVE_PATH',
        message: `RELATIVE PATH: "${file.path}" — paths MUST be absolute (start with /)`,
        detail: `Use the full absolute path, e.g. /Users/dev/project/${file.path}`,
      });
      continue;
    }

    // .md extension check (coder only)
    if (rules.requireMdExtension && extname(file.path).toLowerCase() !== '.md') {
      errors.push({
        code: 'NOT_MARKDOWN',
        message: `NOT A MARKDOWN FILE: "${file.path}" — ${rules.toolName} requires .md files`,
        detail: 'Context files for the coder MUST be Markdown (.md) plan/specification documents.',
      });
      continue;
    }

    // File existence check
    if (!existsSync(file.path)) {
      errors.push({
        code: 'FILE_NOT_FOUND',
        message: `FILE NOT FOUND: "${file.path}" does not exist`,
        detail: 'Ensure the file path is correct and the file has been created.\nIf referencing planner output, make sure spawn_planner has completed first.',
      });
      continue;
    }

    // Readability check
    try {
      accessSync(file.path, constants.R_OK);
    } catch {
      errors.push({
        code: 'FILE_NOT_READABLE',
        message: `FILE NOT READABLE: "${file.path}" exists but cannot be read`,
        detail: 'Check file permissions. The MCP server needs read access to this file.',
      });
      continue;
    }

    // Size check
    try {
      const stat = statSync(file.path);
      if (stat.size > rules.maxFileSizeBytes) {
        errors.push({
          code: 'FILE_TOO_LARGE',
          message: `FILE TOO LARGE: "${file.path}" is ${Math.round(stat.size / 1024)}KB (max: ${Math.round(rules.maxFileSizeBytes / 1024)}KB)`,
        });
        continue;
      }
      totalSize += stat.size;
    } catch (err) {
      errors.push({
        code: 'FILE_STAT_FAILED',
        message: `FILE STAT FAILED: "${file.path}" — ${err instanceof Error ? err.message : 'unknown error'}`,
        detail: 'The file exists but its metadata could not be read. Check for broken symlinks or permission issues.',
      });
      continue;
    }
  }

  // Total size check
  if (totalSize > rules.maxTotalSizeBytes) {
    errors.push({
      code: 'TOTAL_SIZE_EXCEEDED',
      message: `TOTAL FILE SIZE EXCEEDED: ${Math.round(totalSize / 1024)}KB (max: ${Math.round(rules.maxTotalSizeBytes / 1024)}KB)`,
      detail: 'Reduce the number of context files or use smaller files.',
    });
  }

  return { valid: errors.length === 0, errors };
}

// --- Error message formatting ---

export function formatValidationError(toolName: string, errors: ValidationError[]): string {
  const rules = VALIDATION_RULES[toolName];
  if (!rules) return errors.map(e => e.message).join('\n');

  const parts: string[] = [
    `❌ **BRIEF VALIDATION FAILED — ${rules.toolName}**`,
    '',
    '⚠️ **ISSUES FOUND:**',
  ];

  for (const err of errors) {
    parts.push(`• **${err.message}**`);
    if (err.detail) {
      for (const line of err.detail.split('\n')) {
        parts.push(`  ${line}`);
      }
    }
  }

  parts.push('');
  parts.push('📋 **HOW TO FIX — Follow this brief template:**');
  parts.push('```');
  parts.push(rules.briefTemplate);
  parts.push('```');
  parts.push('');
  parts.push(rules.workflowHint);

  return parts.join('\n');
}

// --- Context file content assembly ---

export function assemblePromptWithContext(prompt: string, contextFiles?: ContextFile[]): string {
  if (!contextFiles || contextFiles.length === 0) return prompt;

  const sections: string[] = [prompt, '', '---', '', '## 📎 ATTACHED CONTEXT FILES', ''];

  for (const file of contextFiles) {
    sections.push(`### File: ${file.path}`);
    if (file.description) {
      sections.push(`> ${file.description}`);
    }
    sections.push('');

    try {
      const content = readFileSync(file.path, 'utf-8');
      // Truncate if over limit (should be caught by validation, but safety net)
      const truncated = content.length > MAX_FILE_SIZE
        ? content.slice(0, MAX_FILE_SIZE) + '\n\n[... TRUNCATED — file exceeds 200KB limit ...]'
        : content;
      sections.push('```');
      sections.push(truncated);
      sections.push('```');
    } catch {
      sections.push('> ⚠️ Could not read file contents');
    }
    sections.push('');
  }

  return sections.join('\n');
}
