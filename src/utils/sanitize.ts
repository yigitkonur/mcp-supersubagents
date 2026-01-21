import { z } from 'zod';
import { MODEL_IDS } from '../models.js';
import { TASK_TYPE_IDS } from '../templates/index.js';

export const SpawnTaskSchema = z.object({
  prompt: z.string().min(1).max(50000),
  timeout: z.number().int().min(1000).max(3600000).optional().default(300000),
  cwd: z.string().optional(),
  model: z.enum(MODEL_IDS as [string, ...string[]]).optional(),
  task_type: z.enum(TASK_TYPE_IDS as [string, ...string[]]).optional(),
  autonomous: z.boolean().optional().default(true),
});

export const ResumeTaskSchema = z.object({
  sessionId: z.string().min(1),
  timeout: z.number().int().min(1000).max(3600000).optional().default(300000),
  cwd: z.string().optional(),
  autonomous: z.boolean().optional().default(true),
});

export const GetTaskStatusSchema = z.object({
  taskId: z.string().min(1),
});

export const ListTasksSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
});
