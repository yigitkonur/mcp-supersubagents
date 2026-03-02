import { z } from 'zod';
import { ALL_ACCEPTED_MODELS, MODEL_IDS, DEFAULT_MODEL, OPUS_MODEL } from '../models.js';
import { CODER_LANGUAGES, PLANNING_TYPES, TESTING_TYPES, RESEARCH_TYPES } from '../utils/sanitize.js';
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
  description: `Spawn an autonomous AI agent. Runs isolated — prompt + context_files are its ONLY context.

**Roles:**
- coder: Implementation. Min 1000-char prompt + min 1 .md context file. Include: OBJECTIVE, FILES, CRITERIA, CONSTRAINTS, PATTERNS.
- planner: Architecture/planning. Min 300-char prompt. Always uses opus. Include: PROBLEM, CONSTRAINTS, SCOPE, OUTPUT.
- tester: QA/testing. Min 300-char prompt + min 1 context file. Include: WHAT BUILT, FILES, CRITERIA, TESTS, EDGE CASES.
- researcher: Investigation. Min 200-char prompt. Include: TOPIC, QUESTIONS, HANDOFF TARGET.
- general: General-purpose non-code tasks. Min 200-char prompt. Include: OBJECTIVE, CONTEXT, DELIVERABLES.

**Workflow:** researcher -> planner -> coder -> tester. Chain with depends_on.
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
        description: 'Complete self-contained instructions for the agent. Min length varies by role.',
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path.' },
            description: { type: 'string', description: 'What this file contains.' },
          },
          required: ['path'],
        },
        description: 'Context files. Required for coder (min 1 .md) and tester (min 1). Max 20 files, 200KB each, 500KB total.',
      },
      specialization: {
        type: 'string',
        description: 'Role-specific specialization. coder: typescript/python/react/etc. planner: feature/bugfix/migration/etc. tester: playwright/rest/suite/etc. researcher: security/library/performance/etc. general: writing/analysis/documentation/etc.',
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
