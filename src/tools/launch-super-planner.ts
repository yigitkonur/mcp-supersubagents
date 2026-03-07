import { z } from 'zod';
import { OPUS_MODEL } from '../models.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesOptional, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION, buildContextFilesProperty, buildPromptProperty, buildModelProperty } from './spawn-schemas.js';

// --- Zod schema (planner-specific: context_files optional) ---

const LaunchSuperPlannerSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesOptional,
});

// --- Tool definition ---

export const launchSuperPlannerTool = {
  name: 'launch-super-planner',
  description: `Launch an autonomous planning agent. Designs architecture and creates implementation plans as .md files. Always uses ${OPUS_MODEL} regardless of model parameter. **Use this for any non-trivial task** — if the work touches 3+ files or has ambiguous requirements, plan first.

**Workflow:** researcher → **PLANNER** → coder → tester
Output goes to \`.agent-workspace/plans/[topic]/\`. After completion, read \`task:///{id}\` to get workspace path, then pass ALL .md files from that workspace as context_files to launch-super-coder. Send everything — builder-briefing.md, tester-checklist.md, task specs, the full workspace.

**Status:** Read \`task:///all\` every ~30s to monitor all tasks (status, deps, questions). Statuses: \`running\`, \`waiting → <dep>\`, \`waiting_answer ⏸\`, \`completed\`, \`failed\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: buildPromptProperty(300, 'Planning brief. MUST include: PROBLEM STATEMENT (what to solve), CONSTRAINTS (what\'s ruled out), VERIFIED FACTS (known info), SCOPE (in/out), EXPECTED OUTPUT (what coder needs). Min 300 chars.'),
      context_files: buildContextFilesProperty('Optional reference files (research docs, existing specs). Pass ALL files from prior researcher workspace — don\'t filter. Max 20 files, 200KB each, 500KB total.'),
      ...baseInputSchemaProperties,
      model: buildModelProperty(`Ignored — planner always uses ${OPUS_MODEL}. Parameter kept for backward compatibility only.`),
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
