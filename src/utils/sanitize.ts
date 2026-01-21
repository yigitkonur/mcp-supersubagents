import { z } from 'zod';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { MODEL_IDS } from '../models.js';
import { TASK_TYPE_IDS } from '../templates/index.js';

const PROMPT_MAX_LENGTH = 10000;
const PROMPT_PATTERN = /^[\p{L}\p{N}\s.,!?;:'"()\-_@#$%^&*+=\[\]{}|\\/<>`~\n\r]+$/u;

export function sanitizePrompt(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();

  if (trimmed.length === 0 || trimmed.length > PROMPT_MAX_LENGTH) {
    return null;
  }

  if (!PROMPT_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') {
    return null;
  }

  const trimmed = cwd.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const resolved = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);

  if (!existsSync(resolved)) {
    return null;
  }

  return resolved;
}

export const SpawnTaskSchema = z.object({
  prompt: z.string().min(1).max(PROMPT_MAX_LENGTH),
  timeout: z.number().int().min(1000).max(3600000).optional().default(300000),
  cwd: z.string().optional(),
  model: z.string().refine(
    (val) => !val || MODEL_IDS.includes(val as typeof MODEL_IDS[number]),
    { message: `Invalid model. Valid models: ${MODEL_IDS.join(', ')}` }
  ).optional(),
  task_type: z.string().refine(
    (val) => !val || TASK_TYPE_IDS.includes(val as typeof TASK_TYPE_IDS[number]),
    { message: `Invalid task_type. Valid types: ${TASK_TYPE_IDS.join(', ')}` }
  ).optional(),
  silent: z.boolean().optional().default(true),
  autonomous: z.boolean().optional().default(false),
});

export const ResumeTaskSchema = z.object({
  sessionId: z.string().min(1),
  timeout: z.number().int().min(1000).max(3600000).optional().default(300000),
  cwd: z.string().optional(),
  autonomous: z.boolean().optional().default(false),
});

export const GetTaskStatusSchema = z.object({
  taskId: z.string().min(1),
});

export const ListTasksSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
});

export type SpawnTaskParams = z.infer<typeof SpawnTaskSchema>;
export type GetTaskStatusParams = z.infer<typeof GetTaskStatusSchema>;
export type ListTasksParams = z.infer<typeof ListTasksSchema>;
export type ResumeTaskParams = z.infer<typeof ResumeTaskSchema>;
