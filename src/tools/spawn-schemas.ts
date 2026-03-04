import { z } from 'zod';
import { ALL_ACCEPTED_MODELS, MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { REASONING_EFFORTS, AGENT_MODES } from '../types.js';
import {
  TASK_TIMEOUT_DEFAULT_MS,
  TASK_TIMEOUT_MAX_MS,
  TASK_TIMEOUT_MIN_MS,
} from '../config/timeouts.js';

export const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

/** Context files required (coder, tester) */
export const contextFilesRequired = z.array(contextFileSchema).min(1).max(20);

/** Context files optional (planner, researcher, classic) */
export const contextFilesOptional = z.array(contextFileSchema).max(20).optional();

/** Base fields shared by all spawn schemas. Roles extend this with context_files and mode defaults. */
export const baseSpawnFields = {
  prompt: z.string().min(1).max(100000),
  model: z.enum(ALL_ACCEPTED_MODELS as readonly [string, ...string[]]).optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS)
    .default(TASK_TIMEOUT_DEFAULT_MS).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  reasoning_effort: z.enum(REASONING_EFFORTS as unknown as [string, ...string[]]).optional(),
} as const;

// ---------------------------------------------------------------------------
// MCP JSON Schema shared property definitions
// ---------------------------------------------------------------------------

/** Shared inputSchema properties for MCP tool registration. */
export const baseInputSchemaProperties = {
  model: {
    type: 'string',
    enum: MODEL_IDS,
    description: `Model to use. Default: ${DEFAULT_MODEL}.`,
  },
  cwd: {
    type: 'string',
    description: 'Working directory (absolute path).',
  },
  timeout: {
    type: 'number',
    description: `Max duration in ms. Default: ${TASK_TIMEOUT_DEFAULT_MS}. Max: ${TASK_TIMEOUT_MAX_MS}.`,
  },
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
} as const;

/** Build the standard MCP tool annotations block. Only `title` varies per tool. */
export function buildAnnotations(title: string) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  } as const;
}

/** Standard MCP execution block shared by all spawn tools. */
export const SPAWN_TOOL_EXECUTION = {
  taskSupport: 'forbidden',
} as const;

/** Mode enum values for JSON schema. */
export const MODE_ENUM = [...AGENT_MODES] as string[];
