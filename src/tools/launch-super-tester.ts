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

// --- Zod schema (tester-specific: context_files REQUIRED, any file type) ---

const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

const LaunchSuperTesterSchema = z.object({
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

export const launchSuperTesterTool = {
  name: 'launch-super-tester',
  description: `Launch an autonomous testing agent that writes and runs tests, verifies implementations, and validates edge cases. The agent runs in COMPLETE ISOLATION.

**When to call:** A coder has finished implementation and you need to verify it works. Pass the source files or handoff documents as context_files.

**context_files are MANDATORY** — the call WILL FAIL without them. Any file type accepted (source code, test files, handoff docs).

**Brief template — your prompt MUST include:**
\`\`\`
WHAT WAS BUILT: Feature/fix to verify — specific deliverable
FILES CHANGED: Where to focus testing — absolute paths
SUCCESS CRITERIA: What "working" means — specific, testable conditions
TEST SUGGESTIONS: Specific flows to test — happy path + edge cases
EDGE CASES: Potential failure points the coder is worried about
BASE URL / SETUP: How to access the system under test
\`\`\`

**Workflow position:** researcher → planner → coder → **TESTER**
Chain with \`depends_on\` after the coder task. Pass changed source files and handoff docs as \`context_files\`.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your testing brief. MUST include: WHAT WAS BUILT (feature to verify), FILES CHANGED (absolute paths), SUCCESS CRITERIA (testable conditions), TEST SUGGESTIONS (flows to test), EDGE CASES (failure points). Min 300 chars.',
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
        description: 'REQUIRED. Source files, test files, or handoff docs the tester needs. Any file type accepted. Max 20 files, 200KB each, 500KB total.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}.`,
      },
      cwd: { type: 'string', description: 'Working directory (absolute path).' },
      timeout: { type: 'number', description: `Max duration in ms. Default: ${TASK_TIMEOUT_DEFAULT_MS}. Max: ${TASK_TIMEOUT_MAX_MS}.` },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use to chain after coder.',
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
    title: 'Launch Super Tester',
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

export async function handleLaunchSuperTester(
  args: unknown,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  let parsed: z.infer<typeof LaunchSuperTesterSchema>;
  try {
    parsed = LaunchSuperTesterSchema.parse(args);
  } catch (error) {
    return mcpValidationError(
      `**SCHEMA VALIDATION FAILED — launch-super-tester**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\nRequired: prompt (string, min 300 chars) + context_files (array of file paths).`
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
    toolName: 'tester',
    taskType: 'super-tester',
  };

  return handleSharedSpawn(params, config, ctx);
}
