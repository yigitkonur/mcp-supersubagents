import { z } from 'zod';
import { OPUS_MODEL } from '../models.js';
import { AGENT_MODES } from '../types.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION } from './spawn-schemas.js';

// --- Zod schema (planner-specific: context_files optional) ---

const LaunchSuperPlannerSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
  mode: z.enum(AGENT_MODES as readonly [string, ...string[]]).default('plan').optional(),
});

// --- Tool definition ---

export const launchSuperPlannerTool = {
  name: 'launch-super-planner',
  description: `Launch an autonomous planning agent that designs architecture, creates implementation plans, and produces .md specification files for the coder. Always uses ${OPUS_MODEL} regardless of model parameter.

**When to call:** You need to break down a complex task into a structured plan before coding. The planner produces .md files that the coder consumes.

**Brief template — your prompt MUST include:**
\`\`\`
PROBLEM STATEMENT: What needs to be solved — the actual problem, not a solution
CONSTRAINTS: What's been ruled out, what must be preserved
VERIFIED FACTS: What you already know — don't re-investigate these
SCOPE: What's in/out of scope — be explicit
EXPECTED OUTPUT: What the next agent (Coder/Tester) needs from this plan
\`\`\`

**Workflow position:** researcher → **PLANNER** → coder → tester
The planner creates files at \`.agent-workspace/plans/[topic]/\`. Pass those files as \`context_files\` when spawning \`launch-super-coder\` next.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your planning brief. MUST include: PROBLEM STATEMENT (what to solve), CONSTRAINTS (what\'s ruled out), VERIFIED FACTS (known info), SCOPE (in/out), EXPECTED OUTPUT (what coder needs). Min 300 chars.',
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
        description: 'Optional reference files (research docs, existing specs). Max 20 files, 200KB each, 500KB total.',
      },
      ...baseInputSchemaProperties,
      model: {
        type: 'string',
        enum: baseInputSchemaProperties.model.enum,
        description: `Model parameter accepted but planner ALWAYS uses ${OPUS_MODEL} for maximum reasoning capability.`,
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. Use to chain after researcher.',
      },
      mode: {
        type: 'string',
        enum: ['fleet', 'plan', 'autopilot'],
        description: 'Execution mode. plan=plan-then-execute (default for planner), fleet=parallel sub-agents, autopilot=direct execution.',
        default: 'plan',
      },
    },
    required: ['prompt'],
  },
  annotations: buildAnnotations('Launch Super Planner'),
  execution: SPAWN_TOOL_EXECUTION,
};

// --- Handler ---

export const handleLaunchSuperPlanner = createLaunchHandler(
  LaunchSuperPlannerSchema,
  'launch-super-planner',
  { toolName: 'planner', taskType: 'super-planner' },
  (parsed) => {
    if (parsed.model && parsed.model !== OPUS_MODEL) {
      console.error(`[launch-super-planner] Ignoring model '${parsed.model}', using '${OPUS_MODEL}' for planner.`);
    }
    return { model: OPUS_MODEL };
  },
);
