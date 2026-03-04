import { z } from 'zod';
import { DEFAULT_MODEL } from '../models.js';
import { AGENT_MODES } from '../types.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION } from './spawn-schemas.js';

// --- Zod schema (researcher-specific: context_files optional) ---

const LaunchSuperResearcherSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
  mode: z.enum(AGENT_MODES as readonly [string, ...string[]]).default('autopilot').optional(),
});

// --- Tool definition ---

export const launchSuperResearcherTool = {
  name: 'launch-super-researcher',
  description: `Launch an autonomous research agent that investigates codebases, APIs, libraries, and technical topics. Produces .md research documents for downstream agents.

**When to call:** You need to understand something before planning or coding — existing code structure, API behavior, library capabilities, or technical feasibility. The researcher produces .md files that the planner/coder consume.

**Brief template — your prompt MUST include:**
\`\`\`
WHAT TO RESEARCH: Specific topic or question — not vague "research X"
WHY IT MATTERS: What decision this research informs
WHAT'S ALREADY KNOWN: Don't re-research verified facts
SPECIFIC QUESTIONS: 2-5 pointed, answerable questions
HANDOFF TARGET: Who reads the output — Planner? Coder? Human?
\`\`\`

**Workflow position:** **RESEARCHER** → planner → coder → tester
Research output goes to \`.agent-workspace/researches/[topic]/HANDOFF.md\`. Reference this file when spawning \`launch-super-planner\` or \`launch-super-coder\` next.

**Status:** Read resource \`task:///all\` or \`task:///{id}\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Your research brief. MUST include: WHAT TO RESEARCH (specific topic), WHY IT MATTERS (what decision it informs), WHAT\'S ALREADY KNOWN (verified facts), SPECIFIC QUESTIONS (2-5 pointed questions), HANDOFF TARGET (who reads output). Min 200 chars.',
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
        description: 'Optional reference files for the researcher. Max 20 files, 200KB each, 500KB total.',
      },
      ...baseInputSchemaProperties,
      model: {
        type: 'string',
        enum: baseInputSchemaProperties.model.enum,
        description: `Model to use. Default: ${DEFAULT_MODEL}. Use gpt-5.3-codex-xhigh for deep code analysis.`,
      },
      mode: {
        type: 'string',
        enum: ['fleet', 'plan', 'autopilot'],
        description: 'Execution mode. autopilot=direct autonomous execution (default for researcher), fleet=parallel sub-agents, plan=plan-then-execute.',
        default: 'autopilot',
      },
    },
    required: ['prompt'],
  },
  annotations: buildAnnotations('Launch Super Researcher'),
  execution: SPAWN_TOOL_EXECUTION,
};

// --- Handler ---

export const handleLaunchSuperResearcher = createLaunchHandler(
  LaunchSuperResearcherSchema,
  'launch-super-researcher',
  { toolName: 'researcher', taskType: 'super-researcher' },
);
