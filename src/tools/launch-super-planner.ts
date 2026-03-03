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

// --- Zod schema (planner-specific: context_files optional) ---

const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

const LaunchSuperPlannerSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).max(20).optional(),
  model: z.enum(ALL_ACCEPTED_MODELS as [string, ...string[]]).optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).default(TASK_TIMEOUT_DEFAULT_MS).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  reasoning_effort: z.enum(REASONING_EFFORTS as unknown as [string, ...string[]]).optional(),
  mode: z.enum(['fleet', 'plan', 'autopilot']).default('plan').optional(),
});

// --- Tool definition ---

export const launchSuperPlannerTool = {
  name: 'launch-super-planner',
  description: `Launch an autonomous planning agent that designs architecture, creates implementation plans, and produces .md specification files for the coder. Always uses ${OPUS_MODEL} regardless of model parameter.

**When to call:** You need to break down a complex task into a structured plan before coding. The planner produces .md files that the coder consumes.

**Brief template — your prompt MUST include:**
\`\`\`
PROBLEM STATEMENT: What needs to be solved — the actual problem, not a solution
CONSTRAINTS: What's been ruled out, what must be preserved
VERIFIED FACTS: What you already know — don't re-investigate these
SCOPE: What's in/out of scope — be explicit
EXPECTED OUTPUT: What the next agent (Coder/Tester) needs from this plan
\`\`\`

**Workflow position:** researcher → **PLANNER** → coder → tester
The planner creates files at \`.agent-workspace/plans/[topic]/\`. Pass those files as \`context_files\` when spawning \`launch-super-coder\` next.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your planning brief. MUST include: PROBLEM STATEMENT (what to solve), CONSTRAINTS (what\'s ruled out), VERIFIED FACTS (known info), SCOPE (in/out), EXPECTED OUTPUT (what coder needs). Min 300 chars.',
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path (must start with /).' },
            description: { type: 'string', description: 'What this file contains and why the agent needs it.' },
          },
          required: ['path'],
        },
        description: 'Optional reference files (research docs, existing specs). Max 20 files, 200KB each, 500KB total.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model parameter accepted but planner ALWAYS uses ${OPUS_MODEL} for maximum reasoning capability.`,
      },
      cwd: { type: 'string', description: 'Working directory (absolute path).' },
      timeout: { type: 'number', description: `Max duration in ms. Default: ${TASK_TIMEOUT_DEFAULT_MS}. Max: ${TASK_TIMEOUT_MAX_MS}.` },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use to chain after researcher.',
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
        description: 'Execution mode. plan=plan-then-execute (default for planner), fleet=parallel sub-agents, autopilot=direct execution.',
        default: 'plan',
      },
    },
    required: ['prompt'],
  },
  annotations: {
    title: 'Launch Super Planner',
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

export async function handleLaunchSuperPlanner(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed: z.infer<typeof LaunchSuperPlannerSchema>;
  try {
    parsed = LaunchSuperPlannerSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `**SCHEMA VALIDATION FAILED — launch-super-planner**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\nRequired: prompt (string, min 300 chars).`
    );
  }

  // Planner always uses opus regardless of user input
  const params: SharedSpawnParams = {
    prompt: parsed.prompt,
    context_files: parsed.context_files,
    model: OPUS_MODEL,
    cwd: parsed.cwd,
    timeout: parsed.timeout,
    depends_on: parsed.depends_on,
    labels: parsed.labels,
    reasoning_effort: parsed.reasoning_effort as ReasoningEffort | undefined,
    mode: parsed.mode,
  };

  const config: SpawnToolConfig = {
    toolName: 'planner',
    taskType: 'super-planner',
  };

  return handleSharedSpawn(params, config, ctx);
}
