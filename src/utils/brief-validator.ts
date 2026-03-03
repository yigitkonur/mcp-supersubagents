import { access, stat, lstat, readFile, realpath, constants } from 'fs/promises';
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
  warnings?: ValidationError[];
  fileContents?: Map<string, string>;
}

interface PromptQualityCheck {
  pattern: RegExp;
  label: string;
  hint: string;
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
  promptQualityChecks?: PromptQualityCheck[];
}

// --- Per-tool validation rules ---

const MAX_FILE_SIZE = 200 * 1024;   // 200KB per file
const MAX_TOTAL_SIZE = 500 * 1024;  // 500KB total

const CODER_RULES: ToolValidationRules = {
  toolName: 'launch-super-coder',
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
    '⚠️ YOU MUST CREATE .md FILES BEFORE SPAWNING A CODER:',
    '',
    'Option A — Use a planner agent:',
    '  1. launch-super-planner(prompt: "...") → wait for completion',
    '  2. Planner writes .md files to .agent-workspace/plans/[topic]/',
    '  3. launch-super-coder(context_files: [{ path: ".../builder-briefing.md" }])',
    '',
    'Option B — Write a spec yourself:',
    '  1. Create a .md file with the design/plan/spec',
    '  2. launch-super-coder(context_files: [{ path: "/abs/path/to/spec.md" }])',
    '',
    '💡 If multiple agents need the same context, attach the same .md files to each one.',
    '',
    '📎 Common handoff files:',
    '• Planner output: .agent-workspace/plans/[topic]/05-handoff/builder-briefing.md',
    '• Researcher output: .agent-workspace/researches/[topic]/HANDOFF.md',
  ].join('\n'),
  promptQualityChecks: [
    { pattern: /\/[\w./-]+\.\w+/, label: 'file paths', hint: 'Include absolute file paths the agent should modify' },
    { pattern: /success|criteria|verif|done when|accept/i, label: 'success criteria', hint: 'Add explicit success criteria so the agent knows when it\'s done' },
    { pattern: /constraint|don't|do not|avoid|never|boundary|forbidden/i, label: 'constraints', hint: 'Adding constraints prevents the agent from going off-track' },
  ],
};

const PLANNER_RULES: ToolValidationRules = {
  toolName: 'launch-super-planner',
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
    'Use those files as context_files when spawning launch-super-coder next.',
  ].join('\n'),
  promptQualityChecks: [
    { pattern: /problem|goal|need|solve|issue|challenge/i, label: 'problem statement', hint: 'State the problem clearly — what needs solving, not just what to build' },
    { pattern: /scope|in.scope|out.of.scope|boundary|limit/i, label: 'scope definition', hint: 'Define what\'s in/out of scope to focus the plan' },
  ],
};

const TESTER_RULES: ToolValidationRules = {
  toolName: 'launch-super-tester',
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
  promptQualityChecks: [
    { pattern: /success|criteria|pass|expect|should|working/i, label: 'success criteria', hint: 'Specify what "working" means in testable terms' },
    { pattern: /\/[\w./-]+\.\w+/, label: 'file paths', hint: 'Include file paths of what was changed so the tester knows where to focus' },
  ],
};

const RESEARCHER_RULES: ToolValidationRules = {
  toolName: 'launch-super-researcher',
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
    'Reference this file when spawning launch-super-planner or launch-super-coder next.',
  ].join('\n'),
  promptQualityChecks: [
    { pattern: /\?/, label: 'explicit questions', hint: 'Include explicit questions (with ?) so the researcher has clear targets' },
    { pattern: /planner|coder|builder|human|handoff|deliver/i, label: 'handoff target', hint: 'Specify who reads the output so findings are structured for the right audience' },
  ],
};

const GENERAL_RULES: ToolValidationRules = {
  toolName: 'launch-classic-agent',
  minPromptLength: 200,
  requireContextFiles: false,
  minContextFiles: 0,
  requireMdExtension: false,
  maxFileSizeBytes: MAX_FILE_SIZE,
  maxTotalSizeBytes: MAX_TOTAL_SIZE,
  briefTemplate: [
    '🎯 OBJECTIVE: [What you need done — be specific]',
    '📋 CONTEXT: [Background information and constraints]',
    '📦 DELIVERABLES: [What files/outputs to produce]',
  ].join('\n'),
  workflowHint: [
    '📎 TIP: General agent handles non-code tasks like writing, analysis, documentation, and organization.',
  ].join('\n'),
};

export const VALIDATION_RULES: Record<string, ToolValidationRules> = {
  'coder': CODER_RULES,
  'planner': PLANNER_RULES,
  'tester': TESTER_RULES,
  'researcher': RESEARCHER_RULES,
  'general': GENERAL_RULES,
};

// --- Validation functions ---

export async function validateBrief(
  toolName: string,
  prompt: string,
  contextFiles?: ContextFile[],
  cwd?: string,
): Promise<ValidationResult> {
  const rules = VALIDATION_RULES[toolName];
  if (!rules) return { valid: true, errors: [] };

  const errors: ValidationError[] = [];
  const fileContents = new Map<string, string>();

  // 1. Prompt length check
  if (prompt.length < rules.minPromptLength) {
    errors.push({
      code: 'PROMPT_TOO_SHORT',
      message: `PROMPT TOO SHORT: ${prompt.length} characters (MINIMUM: ${rules.minPromptLength})`,
      detail: `The prompt is the agent's ONLY instruction — it must be detailed enough to work autonomously.\n\nYour prompt MUST include these sections:\n${rules.briefTemplate}`,
    });
  }

  // 2. Context files required check
  const files = contextFiles || [];
  if (rules.requireContextFiles && files.length < rules.minContextFiles) {
    errors.push({
      code: 'MISSING_CONTEXT_FILES',
      message: `MISSING CONTEXT FILES: ${rules.toolName} REQUIRES at least ${rules.minContextFiles} file(s)`,
      detail: rules.requireMdExtension
        ? 'The coder agent runs in complete isolation — context_files are the ONLY way to give it specifications and plans.\n\nHOW TO FIX:\n1. Launch a planner agent first → it produces .md plan files.\n2. Wait for it to complete (use depends_on to chain tasks).\n3. Pass the planner\'s output .md files as context_files to the coder.\n\nExample:\n  launch-super-planner(prompt: "...plan the feature...")   → produces plan.md\n  launch-super-coder(prompt: "...", context_files: [{ path: "/project/.agent-workspace/plans/.../builder-briefing.md" }], depends_on: ["planner-task-id"])\n\nEach file must be an absolute path ending in .md.'
        : 'The tester agent runs in complete isolation — context_files are the ONLY way to tell it what files to test.\n\nHOW TO FIX: Attach the source files or handoff documents the tester needs to verify.\nExample: context_files: [{ path: "/project/src/auth.ts", description: "Auth module to test" }]\nEach file must have an absolute path.',
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
        message: `NOT A MARKDOWN FILE: "${file.path}" — coder agents ONLY accept .md (Markdown) files`,
        detail: `The coder agent cannot use "${file.path}" because it is not a .md file.\n\nHOW TO FIX:\n1. First, spawn a planner or researcher agent to produce .md specification/plan files.\n2. Wait for that agent to complete (use depends_on or check task:///all).\n3. Then spawn the coder with those .md output files in context_files.\n\nAlternatively, write a .md spec file yourself and pass its absolute path.\n\nWRONG:  context_files: [{ path: "/project/src/" }]           ← directory, not a file\nWRONG:  context_files: [{ path: "/project/index.html" }]     ← not a .md file\nRIGHT:  context_files: [{ path: "/project/plan.md" }]        ← .md specification\nRIGHT:  context_files: [{ path: "/project/.agent-workspace/plans/feature/05-handoff/builder-briefing.md" }]`,
      });
      continue;
    }

    // File existence and readability check
    try {
      await access(file.path, constants.R_OK);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        errors.push({
          code: 'FILE_NOT_FOUND',
          message: `FILE NOT FOUND: "${file.path}" does not exist`,
          detail: 'Ensure the file path is correct and the file has been created.\nIf referencing planner output, make sure the planner task has completed first.',
        });
      } else {
        errors.push({
          code: 'FILE_NOT_READABLE',
          message: `FILE NOT READABLE: "${file.path}" exists but cannot be read`,
          detail: 'Check file permissions. The MCP server needs read access to this file.',
        });
      }
      continue;
    }

    // Workspace boundary check (prevent path traversal via symlinks)
    if (cwd) {
      try {
        const resolvedPath = await realpath(file.path);
        const normalizedCwd = await realpath(cwd);
        if (!resolvedPath.startsWith(normalizedCwd + '/') && resolvedPath !== normalizedCwd) {
          errors.push({
            code: 'PATH_TRAVERSAL',
            message: `File "${file.path}" resolves outside workspace boundary`,
          });
          continue;
        }
      } catch {
        // realpath failed — let subsequent checks handle it
      }
    }

    // VE-010: Symlink check — reject symlinks for context files
    try {
      const lstats = await lstat(file.path);
      if (lstats.isSymbolicLink()) {
        errors.push({
          code: 'SYMLINK_NOT_ALLOWED',
          message: `File "${file.path}" is a symlink — symlinks are not allowed for context files`,
        });
        continue;
      }
    } catch {
      // lstat failed — let subsequent checks handle it
    }

    // Size check
    try {
      const fileStat = await stat(file.path);
      if (fileStat.size > rules.maxFileSizeBytes) {
        errors.push({
          code: 'FILE_TOO_LARGE',
          message: `FILE TOO LARGE: "${file.path}" is ${Math.round(fileStat.size / 1024)}KB (max: ${Math.round(rules.maxFileSizeBytes / 1024)}KB)`,
        });
        continue;
      }
      totalSize += fileStat.size;
    } catch (err) {
      errors.push({
        code: 'FILE_STAT_FAILED',
        message: `FILE STAT FAILED: "${file.path}" — ${err instanceof Error ? err.message : 'unknown error'}`,
        detail: 'The file exists but its metadata could not be read. Check for broken symlinks or permission issues.',
      });
      continue;
    }

    // VE-004: Read file content at validation time to avoid TOCTOU
    try {
      const content = await readFile(file.path, 'utf-8');
      if (content.length > rules.maxFileSizeBytes) {
        errors.push({
          code: 'FILE_TOO_LARGE',
          message: `FILE TOO LARGE: "${file.path}" content is ${Math.round(content.length / 1024)}KB (max: ${Math.round(rules.maxFileSizeBytes / 1024)}KB)`,
        });
        continue;
      }
      fileContents.set(file.path, content);
    } catch {
      // readFile failed — already validated access above, treat as non-fatal
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

  // Prompt quality checks (soft warnings — never block spawning)
  const warnings: ValidationError[] = [];
  if (rules.promptQualityChecks) {
    for (const check of rules.promptQualityChecks) {
      if (!check.pattern.test(prompt)) {
        warnings.push({
          code: 'QUALITY_WARNING',
          message: `Missing: ${check.label}`,
          detail: check.hint,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: warnings.length > 0 ? warnings : undefined, fileContents };
}

// --- Error message formatting ---

export function formatValidationError(toolName: string, errors: ValidationError[], warnings?: ValidationError[]): string {
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

  // Append quality warnings when present alongside hard errors
  if (warnings && warnings.length > 0) {
    parts.push('');
    parts.push('💡 **PROMPT QUALITY TIPS (not blocking — but these improve agent results):**');
    for (const warn of warnings) {
      parts.push(`• ${warn.message} — ${warn.detail}`);
    }
  }

  return parts.join('\n');
}

/**
 * Format quality warnings as a one-line summary for success responses.
 * Returns null if no warnings.
 */
export function formatQualityWarnings(warnings?: ValidationError[]): string | null {
  if (!warnings || warnings.length === 0) return null;
  const labels = warnings.map(w => w.message.replace(/^Missing: /, '')).join(', ');
  return `💡 **Prompt tips:** Consider adding: ${labels} — these improve agent results.`;
}

// --- Context file content assembly ---

export async function assemblePromptWithContext(prompt: string, contextFiles?: ContextFile[], cachedContents?: Map<string, string>): Promise<string> {
  if (!contextFiles || contextFiles.length === 0) return prompt;

  const sections: string[] = [prompt, '', '---', '', '## 📎 ATTACHED CONTEXT FILES', ''];

  for (const file of contextFiles) {
    sections.push(`### File: ${file.path}`);
    if (file.description) {
      sections.push(`> ${file.description}`);
    }
    sections.push('');

    try {
      // VE-004: Use pre-read cached content when available to avoid TOCTOU
      const content = cachedContents?.get(file.path) ?? await readFile(file.path, 'utf-8');
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
