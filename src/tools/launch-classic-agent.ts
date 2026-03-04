import { z } from 'zod';
import { AGENT_MODES } from '../types.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION } from './spawn-schemas.js';

// --- Zod schema (general-purpose: context_files optional) ---

const LaunchClassicAgentSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
  mode: z.enum(AGENT_MODES as readonly [string, ...string[]]).default('autopilot').optional(),
});

// --- Tool definition ---

export const launchClassicAgentTool = {
  name: 'launch-classic-agent',
  description: `Launch a general-purpose autonomous agent for non-specialized tasks like writing, analysis, documentation, file organization, data processing, and automation.

**When to call:** The task doesn't fit coder/planner/tester/researcher roles. Use for documentation writing, data transformation, file management, report generation, or any general automation.

**Brief template — your prompt MUST include:**
\`\`\`
OBJECTIVE: What you need done — be specific
CONTEXT: Background information and constraints
DELIVERABLES: What files/outputs to produce
\`\`\`

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your task brief. MUST include: OBJECTIVE (what to do), CONTEXT (background and constraints), DELIVERABLES (expected outputs). Min 200 chars.',
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
        description: 'Optional reference files. Max 20 files, 200KB each, 500KB total.',
      },
      ...baseInputSchemaProperties,
      mode: {
        type: 'string',
        enum: ['fleet', 'plan', 'autopilot'],
        description: 'Execution mode. autopilot=direct autonomous execution (default), fleet=parallel sub-agents, plan=plan-then-execute.',
        default: 'autopilot',
      },
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
