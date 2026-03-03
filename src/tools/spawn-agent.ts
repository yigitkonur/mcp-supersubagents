import { z } from 'zod';
import { ALL_ACCEPTED_MODELS, MODEL_IDS, DEFAULT_MODEL, OPUS_MODEL } from '../models.js';
import { handleSharedSpawn, type SharedSpawnParams, type SpawnToolConfig } from './shared-spawn.js';
import type { TaskType } from '../templates/index.js';
import { REASONING_EFFORTS, type ToolContext, type ReasoningEffort } from '../types.js';
import { mcpValidationError } from '../utils/format.js';
import {
  TASK_TIMEOUT_DEFAULT_MS,
  TASK_TIMEOUT_MAX_MS,
  TASK_TIMEOUT_MIN_MS,
} from '../config/timeouts.js';

// --- Role definitions ---

const ROLES = ['coder', 'planner', 'tester', 'researcher', 'general'] as const;
type Role = typeof ROLES[number];

const ROLE_TO_TASK_TYPE: Record<Role, TaskType> = {
  coder: 'super-coder',
  planner: 'super-planner',
  tester: 'super-tester',
  researcher: 'super-researcher',
  general: 'super-general',
};

// --- Zod schema ---

const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

const SpawnAgentSchema = z.object({
  role: z.enum(ROLES),
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).max(20).optional(),
  specialization: z.string().optional(),
  model: z.enum(ALL_ACCEPTED_MODELS as [string, ...string[]]).optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).default(TASK_TIMEOUT_DEFAULT_MS).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  reasoning_effort: z.enum(REASONING_EFFORTS as unknown as [string, ...string[]]).optional(),
  mode: z.enum(['fleet', 'plan', 'autopilot']).default('fleet').optional(),
});

// --- Tool definition ---

export const spawnAgentTool = {
  name: 'spawn_agent',
  description: `Spawn an autonomous AI agent. Each agent runs in COMPLETE ISOLATION — the prompt + context_files are its ONLY context. It cannot see your conversation, other agents' output, or any prior state.

**⚠️ CRITICAL: context_files are how agents receive information.**
- coder and tester REQUIRE context_files — the call WILL BE REJECTED without them.
- coder ONLY accepts .md files (Markdown plans/specs). You MUST create these first (via planner/researcher agents or manually), then pass their output files here.
- Files common to multiple agents (e.g., a shared spec or research doc) should be attached to EACH agent that needs them — agents cannot see each other's files.

**Roles:**
- coder: Implementation. REQUIRES min 1000-char prompt + min 1 .md context file. You MUST first create .md plan/spec files (via planner or manually), then pass them as context_files. Include: OBJECTIVE, FILES, CRITERIA, CONSTRAINTS, PATTERNS.
- planner: Architecture/planning. Min 300-char prompt. Always uses opus. Produces .md plan files that the coder consumes. Include: PROBLEM, CONSTRAINTS, SCOPE, OUTPUT.
- tester: QA/testing. REQUIRES min 300-char prompt + min 1 context file (any type). Include: WHAT BUILT, FILES, CRITERIA, TESTS, EDGE CASES.
- researcher: Investigation. Min 200-char prompt. Produces .md research files that planner/coder consume. Include: TOPIC, QUESTIONS, HANDOFF TARGET.
- general: General-purpose non-code tasks. Min 200-char prompt. Include: OBJECTIVE, CONTEXT, DELIVERABLES.

**Workflow:** researcher → planner → coder → tester. Chain with depends_on. Each upstream agent produces files that downstream agents consume via context_files.
**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string',
        enum: [...ROLES],
        description: 'Agent role: coder, planner, tester, researcher, or general.',
      },
      prompt: {
        type: 'string',
        description: 'Complete self-contained instructions for the agent. This is the agent\'s ONLY instruction — it must be detailed enough to work autonomously. Min length varies by role (coder: 1000 chars, planner: 300, tester: 300, researcher: 200, general: 200).',
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
        description: 'MANDATORY for coder and tester — call will fail without them. For coder: must be .md files (Markdown plans, specs, research docs). Create these files FIRST (via planner/researcher agents or manually), then reference them here. Pass the SAME shared files to every agent that needs them. Max 20 files, 200KB each, 500KB total. Each file needs an absolute path.',
      },
      specialization: {
        type: 'string',
        description: '(Deprecated — agents now load domain skills at runtime via search-skills + get-skill-details. This parameter is accepted but ignored.)',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model. Default: ${DEFAULT_MODEL}. Planner always uses ${OPUS_MODEL} regardless.`,
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
        description: 'Execution mode. fleet=parallel sub-agents (default), plan=plan-then-execute, autopilot=direct autonomous execution.',
        default: 'fleet',
      },
    },
    required: ['role', 'prompt'],
  },
  annotations: {
    title: 'Spawn Agent',
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

export async function handleSpawnAgent(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed: z.infer<typeof SpawnAgentSchema>;
  try {
    parsed = SpawnAgentSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `**SCHEMA VALIDATION FAILED — spawn_agent**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\nRequired: role (coder|planner|tester|researcher|general) + prompt (string).`
    );
  }

  const role = parsed.role;
  const taskType = ROLE_TO_TASK_TYPE[role];
  // Planner always uses opus regardless of user input
  const model = role === 'planner' ? OPUS_MODEL : parsed.model;

  const params: SharedSpawnParams = {
    prompt: parsed.prompt,
    context_files: parsed.context_files,
    model,
    cwd: parsed.cwd,
    timeout: parsed.timeout,
    depends_on: parsed.depends_on,
    labels: parsed.labels,
    reasoning_effort: parsed.reasoning_effort as ReasoningEffort | undefined,
    mode: parsed.mode,
  };

  const config: SpawnToolConfig = {
    toolName: `spawn_agent`,
    taskType,
    specialization: parsed.specialization,
  };

  // Use the role name for brief validation (maps to VALIDATION_RULES in brief-validator)
  const validationConfig: SpawnToolConfig = {
    ...config,
    toolName: role,
  };

  return handleSharedSpawn(params, validationConfig, ctx);
}
