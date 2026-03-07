import { z } from 'zod';
import { DEFAULT_MODEL } from '../models.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION, buildContextFilesProperty, buildPromptProperty, buildModelProperty } from './spawn-schemas.js';

// --- Zod schema (general-purpose: context_files optional) ---

const LaunchClassicAgentSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
});

// --- Tool definition ---

export const launchClassicAgentTool = {
  name: 'launch-classic-agent',
  description: `Launch a general-purpose autonomous agent for non-specialized tasks: documentation, analysis, file organization, data processing, report generation, or any automation that doesn't fit coder/planner/tester/researcher. Investigate first — have the agent explore and understand before producing output. Keeps context across the session — good for iterative or exploratory work.

**Status:** Read \`task:///all\` every ~30s to monitor all tasks (status, deps, questions). Statuses: \`running\`, \`waiting → <dep>\`, \`waiting_answer ⏸\`, \`completed\`, \`failed\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: buildPromptProperty(200, 'Task brief. MUST include: OBJECTIVE (what to do), CONTEXT (background and constraints), DELIVERABLES (expected outputs). Min 200 chars.'),
      context_files: buildContextFilesProperty('Optional reference files. Max 20 files, 200KB each, 500KB total.'),
      ...baseInputSchemaProperties,
      model: buildModelProperty(`Model to use. Default: ${DEFAULT_MODEL}. Also accepts aliases: sonnet, opus, gpt-5.4, o4-mini, etc.`),
    },
    required: ['prompt'],
  },
  annotations: buildAnnotations('Launch Classic Agent'),
  execution: SPAWN_TOOL_EXECUTION,
};

// --- Handler ---

export const handleLaunchClassicAgent = createLaunchHandler(
  LaunchClassicAgentSchema,
  'launch-classic-agent',
  { toolName: 'general', taskType: 'super-general' },
);
