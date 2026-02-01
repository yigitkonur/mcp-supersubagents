import { z } from 'zod';
import { MODEL_IDS } from '../models.js';
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
  model: z.enum(MODEL_IDS as [string, ...string[]]).optional(),
  task_type: z.enum(TASK_TYPE_IDS as [string, ...string[]]).optional(),
  autonomous: z.boolean().optional().default(true),
  depends_on: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
});

export const ResumeTaskSchema = z.object({
  sessionId: z.string().min(1),
  timeout: z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).optional().default(TASK_TIMEOUT_DEFAULT_MS), // 30 minutes default
  cwd: z.string().optional(),
  autonomous: z.boolean().optional().default(true),
});

export const GetTaskStatusSchema = z.object({
  taskId: z.union([z.string().min(1), z.array(z.string().min(1))]),
});

export const ListTasksSchema = z.object({
  status: z.enum(['pending', 'waiting', 'running', 'completed', 'failed', 'cancelled', 'rate_limited', 'timed_out']).optional(),
  label: z.string().min(1).optional(),
});
