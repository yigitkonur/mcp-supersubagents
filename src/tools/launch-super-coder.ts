import { z } from 'zod';
import { ALL_ACCEPTED_MODELS, MODEL_IDS, DEFAULT_MODEL, OPUS_MODEL } from '../models.js';
import { handleSharedSpawn, type SharedSpawnParams, type SpawnToolConfig } from './shared-spawn.js';
import { REASONING_EFFORTS, type ToolContext, type ReasoningEffort } from '../types.js';
import { mcpValidationError } from '../utils/format.js';
import {
  TASK_TIMEOUT_DEFAULT_MS,
  TASK_TIMEOUT_MAX_MS,
  TASK_TIMEOUT_MIN_MS,
} from '../config/timeouts.js';

// --- Zod schema (coder-specific: context_files REQUIRED, no .optional()) ---

const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

const LaunchSuperCoderSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).min(1).max(20),
  model: z.enum(ALL_ACCEPTED_MODELS as [string, ...string[]]).optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).default(TASK_TIMEOUT_DEFAULT_MS).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  reasoning_effort: z.enum(REASONING_EFFORTS as unknown as [string, ...string[]]).optional(),
  mode: z.enum(['fleet', 'plan', 'autopilot']).default('fleet').optional(),
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
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}. Use gpt-5.3-codex-xhigh for maximum reasoning.`,
      },
      cwd: { type: 'string', description: 'Working directory (absolute path).' },
      timeout: { type: 'number', description: `Max duration in ms. Default: ${TASK_TIMEOUT_DEFAULT_MS}. Max: ${TASK_TIMEOUT_MAX_MS}.` },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use to chain after planner/researcher.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for grouping/filtering (max 10, 50 chars each).',
      },
      reasoning_effort: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh'],
        description: 'Reasoning effort level. Higher = more thorough but slower/costlier.',
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
  annotations: {
    title: 'Launch Super Coder',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  execution: {
    taskSupport: 'forbidden',
  },
};

// --- Handler ---

export async function handleLaunchSuperCoder(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed: z.infer<typeof LaunchSuperCoderSchema>;
  try {
    parsed = LaunchSuperCoderSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `**SCHEMA VALIDATION FAILED — launch-super-coder**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\nRequired: prompt (string, min 1000 chars) + context_files (array of .md file paths).`
    );
  }

  const params: SharedSpawnParams = {
    prompt: parsed.prompt,
    context_files: parsed.context_files,
    model: parsed.model,
    cwd: parsed.cwd,
    timeout: parsed.timeout,
    depends_on: parsed.depends_on,
    labels: parsed.labels,
    reasoning_effort: parsed.reasoning_effort as ReasoningEffort | undefined,
    mode: parsed.mode,
  };

  const config: SpawnToolConfig = {
    toolName: 'coder',
    taskType: 'super-coder',
  };

  return handleSharedSpawn(params, config, ctx);
}
