import { z } from 'zod';
import { DEFAULT_MODEL } from '../models.js';
import { AGENT_MODES } from '../types.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesRequired, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION } from './spawn-schemas.js';

// --- Zod schema (coder-specific: context_files REQUIRED, no .optional()) ---

const LaunchSuperCoderSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesRequired,
  mode: z.enum(AGENT_MODES as readonly [string, ...string[]]).default('fleet').optional(),
});

// --- Tool definition ---

export const launchSuperCoderTool = {
  name: 'launch-super-coder',
  description: `Launch an autonomous coding agent that implements features, fixes bugs, and refactors code. The agent runs in COMPLETE ISOLATION — the prompt + context_files are its ONLY context.

**When to call:** You have a clear implementation plan (as .md files) and need code written, modified, or refactored. Always run a planner or researcher first to produce .md specs, then pass those specs here.

**context_files are MANDATORY** — the call WILL FAIL without them. Only .md files are accepted (Markdown plans, specs, research docs). Create these files FIRST via \`launch-super-planner\` or \`launch-super-researcher\`, then reference their output files here.

**Brief template — your prompt MUST include:**
\`\`\`
OBJECTIVE: What exactly to build/modify — specific deliverables
FILES TO MODIFY: ALL absolute file paths the agent needs to touch
SUCCESS CRITERIA: How to verify the implementation is correct
CONSTRAINTS: What NOT to do — boundaries, forbidden approaches
PATTERNS TO FOLLOW: Existing code patterns to match, utilities to reuse
CONTEXT: Background — why this matters, dependencies, architectural decisions
\`\`\`

**Workflow position:** researcher → planner → **CODER** → tester
Chain with \`depends_on\`. Each upstream agent produces .md files that the coder consumes via \`context_files\`.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your implementation brief. MUST include: OBJECTIVE (what to build), FILES TO MODIFY (absolute paths), SUCCESS CRITERIA (how to verify), CONSTRAINTS (what NOT to do), PATTERNS (existing code to follow), CONTEXT (background). Min 1000 chars.',
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path to a .md file (must start with /).' },
            description: { type: 'string', description: 'What this file contains and why the agent needs it.' },
          },
          required: ['path'],
        },
        description: 'REQUIRED. Markdown (.md) plan/spec files for the coder. Create via launch-super-planner first, then pass output files here. Max 20 files, 200KB each, 500KB total.',
      },
      ...baseInputSchemaProperties,
      model: {
        type: 'string',
        enum: baseInputSchemaProperties.model.enum,
        description: `Model to use. Default: ${DEFAULT_MODEL}. Use gpt-5.3-codex-xhigh for maximum reasoning.`,
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use to chain after planner/researcher.',
      },
      mode: {
        type: 'string',
        enum: ['fleet', 'plan', 'autopilot'],
        description: 'Execution mode. fleet=parallel sub-agents (default), plan=plan-then-execute, autopilot=direct autonomous execution.',
        default: 'fleet',
      },
    },
    required: ['prompt', 'context_files'],
  },
  annotations: buildAnnotations('Launch Super Coder'),
  execution: SPAWN_TOOL_EXECUTION,
};

// --- Handler ---

export const handleLaunchSuperCoder = createLaunchHandler(
  LaunchSuperCoderSchema,
  'launch-super-coder',
  { toolName: 'coder', taskType: 'super-coder' },
);
