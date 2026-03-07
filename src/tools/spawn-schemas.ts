import { z } from 'zod';
import { DEFAULT_MODEL, getAvailableModelIds, MODEL_ALIASES } from '../models.js';
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

/** Base fields shared by all spawn schemas. Roles extend this with context_files. */
export const baseSpawnFields = {
  prompt: z.string().min(1).max(100000),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS)
    .default(TASK_TIMEOUT_DEFAULT_MS).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
} as const;

// ---------------------------------------------------------------------------
// MCP JSON Schema shared property definitions
// ---------------------------------------------------------------------------

/** Shared inputSchema properties for MCP tool registration. */
export const baseInputSchemaProperties = {
  model: {
    type: 'string',
    get enum() {
      const available = getAvailableModelIds();
      const aliases = Object.entries(MODEL_ALIASES)
        .filter(([, target]) => available.includes(target as typeof available[number]))
        .map(([alias]) => alias);
      return [...available, ...aliases];
    },
    description: `Model to use. Default: ${DEFAULT_MODEL}. Accepts canonical IDs and aliases such as sonnet, opus, gpt-5.4, and o4-mini.`,
  },
  cwd: {
    type: 'string',
    description: 'Working directory override (absolute path). Usually omit — server auto-detects project root. Set only if the agent needs a different root.',
  },
  depends_on: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    description: 'Task IDs that must complete before this starts. Handles execution ORDER only — you still must specify context_files with known paths or spawn after reading predecessor output via task:///{id}.',
  },
  labels: {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 50 },
    maxItems: 10,
    description: 'Tags for grouping related tasks, e.g. "auth", "frontend", "v2-migration". Max 10 labels, 50 chars each.',
  },
} as const;

/** Build a model property that preserves lazy enum evaluation in final tool schemas. */
export function buildModelProperty(description?: string) {
  return {
    type: 'string' as const,
    get enum() {
      return baseInputSchemaProperties.model.enum;
    },
    description: description || baseInputSchemaProperties.model.description,
  };
}

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

// ---------------------------------------------------------------------------
// MCP JSON Schema helpers for role-specific properties
// ---------------------------------------------------------------------------

/** Shared context_files item schema for MCP tool registration. */
export const contextFilesItemSchema_MCP = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, description: 'Absolute file path (must start with /).' },
    description: { type: 'string', maxLength: 2000, description: 'STRONGLY RECOMMENDED. Tells the agent what this file is and why it matters. Injected directly into the agent prompt — without it, the agent must guess file purpose from content alone.' },
  },
  required: ['path'],
} as const;

/** Build context_files property for MCP inputSchema with array bounds. */
export function buildContextFilesProperty(description: string, opts?: { required?: boolean }) {
  return {
    type: 'array' as const,
    items: contextFilesItemSchema_MCP,
    ...(opts?.required ? { minItems: 1 } : {}),
    maxItems: 20,
    description,
  };
}

/**
 * Build prompt property with role-specific minLength.
 * Aligns JSON schema minLength with brief-validator enforcement.
 */
export function buildPromptProperty(minLength: number, description: string) {
  return {
    type: 'string' as const,
    minLength,
    maxLength: 100000,
    description,
  };
}
