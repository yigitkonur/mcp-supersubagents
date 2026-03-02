import type { AgentMode } from '../types.js';

/** Suffix prompts appended to task prompts based on mode */
export const MODE_SUFFIX_PROMPTS: Record<AgentMode, string> = {
  autopilot: '', // No suffix — pure autonomous execution
  plan: [
    '',
    '--- EXECUTION MODE: PLAN-FIRST ---',
    'Before making any changes, create a detailed implementation plan:',
    '1. Analyze the full scope of work and identify all files to modify',
    '2. Break the task into ordered steps with clear acceptance criteria',
    '3. Consider edge cases, error handling, and testing',
    '4. Then execute each step methodically, verifying as you go',
  ].join('\n'),
  fleet: [
    '',
    '--- EXECUTION MODE: FLEET (PARALLEL AGENTS) ---',
    'Break this task into independent parallel subtasks wherever possible:',
    '1. Analyze the work and identify subtasks that can run concurrently',
    '2. Use the Task tool to spawn sub-agents for each independent subtask',
    '3. Assign clear, self-contained briefs to each sub-agent with all context needed',
    '4. Coordinate outputs and resolve any integration points after sub-agents complete',
    '5. Maximize parallelism — only serialize steps that have true data dependencies',
  ].join('\n'),
};

/** Get the suffix prompt for a given mode (empty string for autopilot) */
export function getModeSuffixPrompt(mode: AgentMode): string {
  return MODE_SUFFIX_PROMPTS[mode] ?? '';
}
