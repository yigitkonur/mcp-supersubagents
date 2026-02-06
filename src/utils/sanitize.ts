import { z } from 'zod';
import { ALL_ACCEPTED_MODELS } from '../models.js';
import { TASK_TYPE_IDS } from '../templates/index.js';
import {
  TASK_TIMEOUT_DEFAULT_MS,
  TASK_TIMEOUT_MAX_MS,
  TASK_TIMEOUT_MIN_MS,
} from '../config/timeouts.js';

export const SpawnTaskSchema = z.object({
  prompt: z.string().min(1).max(50000),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).optional().default(TASK_TIMEOUT_DEFAULT_MS), // 30 minutes default
  cwd: z.string().optional(),
  model: z.enum(ALL_ACCEPTED_MODELS as [string, ...string[]]).optional(),
  task_type: z.enum(TASK_TYPE_IDS as [string, ...string[]]).optional(),
  autonomous: z.boolean().optional().default(true),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
});

