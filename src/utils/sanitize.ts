import { z } from 'zod';
import { ALL_ACCEPTED_MODELS } from '../models.js';
import { TASK_TYPE_IDS } from '../templates/index.js';
import {
  TASK_TIMEOUT_DEFAULT_MS,
  TASK_TIMEOUT_MAX_MS,
  TASK_TIMEOUT_MIN_MS,
} from '../config/timeouts.js';
import { AGENT_MODES, DEFAULT_AGENT_MODE, REASONING_EFFORTS } from '../types.js';

// --- Shared field schemas ---

const sharedTimeoutSchema = z.number().int().min(TASK_TIMEOUT_MIN_MS).max(TASK_TIMEOUT_MAX_MS).default(TASK_TIMEOUT_DEFAULT_MS).optional();
const sharedModelSchema = z.enum(ALL_ACCEPTED_MODELS as [string, ...string[]]).optional();
const sharedDependsOnSchema = z.array(z.string().min(1)).max(50).optional();
const sharedLabelsSchema = z.array(z.string().min(1).max(50)).max(10).optional();
const sharedReasoningEffortSchema = z.enum(REASONING_EFFORTS as unknown as [string, ...string[]]).optional();
const sharedModeSchema = z.enum(AGENT_MODES as unknown as [string, ...string[]]).default(DEFAULT_AGENT_MODE).optional();

const contextFileSchema = z.object({
  path: z.string().min(1),
  description: z.string().max(2000).optional(),
});

// --- Legacy spawn_task schema (backward compat) ---

export const SpawnTaskSchema = z.object({
  prompt: z.string().min(1).max(50000),
  timeout: sharedTimeoutSchema,
  cwd: z.string().regex(/^\//, 'cwd must be an absolute path').optional(),
  model: sharedModelSchema,
  task_type: z.enum(TASK_TYPE_IDS as [string, ...string[]]).optional(),
  depends_on: sharedDependsOnSchema,
  labels: sharedLabelsSchema,
  context_files: z.array(contextFileSchema).max(20).optional(),
  reasoning_effort: sharedReasoningEffortSchema,
  mode: sharedModeSchema,
});

// --- Coder languages ---

export const CODER_LANGUAGES = [
  'typescript', 'python', 'rust', 'go', 'java', 'ruby', 'swift', 'csharp', 'kotlin',
  'react', 'nextjs', 'vue', 'supabase', 'tauri', 'triggerdev', 'supastarter',
  'general', 'general-purpose',
] as const;
export type CoderLanguage = typeof CODER_LANGUAGES[number];

// --- Planner types ---

export const PLANNING_TYPES = [
  'feature', 'bugfix', 'migration', 'refactor', 'architecture', 'general-purpose',
] as const;
export type PlanningType = typeof PLANNING_TYPES[number];

// --- Testing types ---

export const TESTING_TYPES = [
  'playwright', 'rest', 'graphql', 'suite', 'accessibility', 'performance', 'security', 'general', 'general-purpose',
] as const;
export type TestingType = typeof TESTING_TYPES[number];

// --- Research types ---

export const RESEARCH_TYPES = [
  'security', 'library', 'performance', 'architecture', 'general', 'general-purpose',
] as const;
export type ResearchType = typeof RESEARCH_TYPES[number];

// --- Per-tool schemas ---

export const SpawnCoderSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).min(1).max(20),
  language: z.enum(CODER_LANGUAGES).optional(),
  model: sharedModelSchema,
  cwd: z.string().optional(),
  timeout: sharedTimeoutSchema,
  depends_on: sharedDependsOnSchema,
  labels: sharedLabelsSchema,
  reasoning_effort: sharedReasoningEffortSchema,
  mode: sharedModeSchema,
});

export const SpawnPlannerSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).max(20).optional(),
  planning_type: z.enum(PLANNING_TYPES).optional(),
  model: sharedModelSchema,
  cwd: z.string().optional(),
  timeout: sharedTimeoutSchema,
  depends_on: sharedDependsOnSchema,
  labels: sharedLabelsSchema,
  reasoning_effort: sharedReasoningEffortSchema,
  mode: sharedModeSchema,
});

export const SpawnTesterSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).min(1).max(20),
  testing_type: z.enum(TESTING_TYPES).optional(),
  model: sharedModelSchema,
  cwd: z.string().optional(),
  timeout: sharedTimeoutSchema,
  depends_on: sharedDependsOnSchema,
  labels: sharedLabelsSchema,
  reasoning_effort: sharedReasoningEffortSchema,
  mode: sharedModeSchema,
});

export const SpawnResearcherSchema = z.object({
  prompt: z.string().min(1).max(100000),
  context_files: z.array(contextFileSchema).max(20).optional(),
  research_type: z.enum(RESEARCH_TYPES).optional(),
  model: sharedModelSchema,
  cwd: z.string().optional(),
  timeout: sharedTimeoutSchema,
  depends_on: sharedDependsOnSchema,
  labels: sharedLabelsSchema,
  reasoning_effort: sharedReasoningEffortSchema,
  mode: sharedModeSchema,
});


