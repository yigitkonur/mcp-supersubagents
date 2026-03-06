import { z } from 'zod';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION, buildContextFilesProperty, buildPromptProperty } from './spawn-schemas.js';

// --- Zod schema (general-purpose: context_files optional) ---

const LaunchClassicAgentSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
});

// --- Tool definition ---

export const launchClassicAgentTool = {
  name: 'launch-classic-agent',
  description: `Launch a general-purpose autonomous agent for non-specialized tasks: documentation, analysis, file organization, data processing, report generation, or any automation that doesn't fit coder/planner/tester/researcher. Investigate first — have the agent explore and understand before producing output. Keeps context across the session — good for iterative or exploratory work.

**Status:** Read \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: buildPromptProperty(200, 'Task brief. MUST include: OBJECTIVE (what to do), CONTEXT (background and constraints), DELIVERABLES (expected outputs). Min 200 chars.'),
      context_files: buildContextFilesProperty('Optional reference files. Max 20 files, 200KB each, 500KB total.'),
      ...baseInputSchemaProperties,
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
