import { z } from 'zod';
import { DEFAULT_MODEL } from '../models.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION, buildContextFilesProperty, buildPromptProperty, buildModelProperty } from './spawn-schemas.js';

// --- Zod schema (researcher-specific: context_files optional) ---

const LaunchSuperResearcherSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
});

// --- Tool definition ---

export const launchSuperResearcherTool = {
  name: 'launch-super-researcher',
  description: `Launch an autonomous research agent. Investigates codebases, APIs, libraries, and technical topics. Produces .md research documents for downstream agents. **Investigate before you solve** — use this before planning or coding when the problem space is unclear.

**Workflow:** **RESEARCHER** → planner → coder → tester
Output goes to \`.agent-workspace/researches/[topic]/\`. After completion, read \`task:///{id}\` to get the workspace path, then pass ALL .md files from that workspace as context_files to the next agent (planner or coder). Don't cherry-pick — send everything.

**Status:** Read \`task:///all\` every ~30s to monitor all tasks (status, deps, questions). Statuses: \`running\`, \`waiting → <dep>\`, \`waiting_answer ⏸\`, \`completed\`, \`failed\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: buildPromptProperty(200, 'Research brief. MUST include: WHAT TO RESEARCH (specific topic), WHY IT MATTERS (what decision it informs), WHAT\'S ALREADY KNOWN (verified facts), SPECIFIC QUESTIONS (2-5 pointed questions), HANDOFF TARGET (who reads output). Min 200 chars.'),
      context_files: buildContextFilesProperty('Optional reference files for the researcher. Pass ALL relevant files from prior agent workspaces — don\'t filter. Max 20 files, 200KB each, 500KB total.'),
      ...baseInputSchemaProperties,
      model: buildModelProperty(`Model to use. Default: ${DEFAULT_MODEL}. Also accepts aliases: sonnet, opus, gpt-5.4, o4-mini, etc.`),
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
