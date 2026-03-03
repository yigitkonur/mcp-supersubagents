import { z } from 'zod';
import { ALL_ACCEPTED_MODELS, MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { handleSharedSpawn, type SharedSpawnParams, type SpawnToolConfig } from './shared-spawn.js';
import { REASONING_EFFORTS, type ToolContext, type ReasoningEffort } from '../types.js';
import { mcpValidationError } from '../utils/format.js';
import {
  TASK_TIMEOUT_DEFAULT_MS,
  TASK_TIMEOUT_MAX_MS,
  TASK_TIMEOUT_MIN_MS,
} from '../config/timeouts.js';

// --- Zod schema (researcher-specific: context_files optional) ---

const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

const LaunchSuperResearcherSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).max(20).optional(),
  model: z.enum(ALL_ACCEPTED_MODELS as [string, ...string[]]).optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).default(TASK_TIMEOUT_DEFAULT_MS).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  reasoning_effort: z.enum(REASONING_EFFORTS as unknown as [string, ...string[]]).optional(),
  mode: z.enum(['fleet', 'plan', 'autopilot']).default('autopilot').optional(),
});

// --- Tool definition ---

export const launchSuperResearcherTool = {
  name: 'launch-super-researcher',
  description: `Launch an autonomous research agent that investigates codebases, APIs, libraries, and technical topics. Produces .md research documents for downstream agents.

**When to call:** You need to understand something before planning or coding — existing code structure, API behavior, library capabilities, or technical feasibility. The researcher produces .md files that the planner/coder consume.

**Brief template — your prompt MUST include:**
\`\`\`
WHAT TO RESEARCH: Specific topic or question — not vague "research X"
WHY IT MATTERS: What decision this research informs
WHAT'S ALREADY KNOWN: Don't re-research verified facts
SPECIFIC QUESTIONS: 2-5 pointed, answerable questions
HANDOFF TARGET: Who reads the output — Planner? Coder? Human?
\`\`\`

**Workflow position:** **RESEARCHER** → planner → coder → tester
Research output goes to \`.agent-workspace/researches/[topic]/HANDOFF.md\`. Reference this file when spawning \`launch-super-planner\` or \`launch-super-coder\` next.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your research brief. MUST include: WHAT TO RESEARCH (specific topic), WHY IT MATTERS (what decision it informs), WHAT\'S ALREADY KNOWN (verified facts), SPECIFIC QUESTIONS (2-5 pointed questions), HANDOFF TARGET (who reads output). Min 200 chars.',
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
        description: 'Optional reference files for the researcher. Max 20 files, 200KB each, 500KB total.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}. Use gpt-5.3-codex-xhigh for deep code analysis.`,
      },
      cwd: { type: 'string', description: 'Working directory (absolute path).' },
      timeout: { type: 'number', description: `Max duration in ms. Default: ${TASK_TIMEOUT_DEFAULT_MS}. Max: ${TASK_TIMEOUT_MAX_MS}.` },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts.',
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
        description: 'Execution mode. autopilot=direct autonomous execution (default for researcher), fleet=parallel sub-agents, plan=plan-then-execute.',
        default: 'autopilot',
      },
    },
    required: ['prompt'],
  },
  annotations: {
    title: 'Launch Super Researcher',
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

export async function handleLaunchSuperResearcher(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed: z.infer<typeof LaunchSuperResearcherSchema>;
  try {
    parsed = LaunchSuperResearcherSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `**SCHEMA VALIDATION FAILED — launch-super-researcher**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\nRequired: prompt (string, min 200 chars).`
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
    toolName: 'researcher',
    taskType: 'super-researcher',
  };

  return handleSharedSpawn(params, config, ctx);
}
