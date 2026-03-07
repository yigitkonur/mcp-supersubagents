import { z } from 'zod';
import { DEFAULT_MODEL } from '../models.js';
import { createLaunchHandler } from './shared-spawn.js';
import { baseSpawnFields, contextFilesRequired, baseInputSchemaProperties, buildAnnotations, SPAWN_TOOL_EXECUTION, buildContextFilesProperty, buildPromptProperty, buildModelProperty } from './spawn-schemas.js';

// --- Zod schema (coder-specific: context_files REQUIRED, no .optional()) ---

const LaunchSuperCoderSchema = z.object({
  ...baseSpawnFields,
  context_files: contextFilesRequired,
});

// --- Tool definition ---

export const launchSuperCoderTool = {
  name: 'launch-super-coder',
  description: `Launch an autonomous coding agent for implementation, bug fixes, and refactoring. Runs in COMPLETE ISOLATION — the prompt + context_files are its ONLY context. The coder is always the final implementation stage — **investigate and plan before coding** for non-trivial tasks.

**context_files are MANDATORY and ONLY .md files are accepted.** Pass .ts/.js/.json and it WILL fail. Create .md specs via launch-super-planner first, or write one yourself.

**Workflow:** researcher → planner → **CODER** → tester
After planner completes, read \`task:///{id}\` to get workspace path, then pass ALL .md files from that workspace as context_files here. Don't cherry-pick — send everything.
Coder writes detailed testing notes to \`.agent-workspace/implementation/[topic]/HANDOFF.md\` — including Playwright hints for UI or curl commands for APIs — which the tester consumes.

**Status:** Read \`task:///all\` every ~30s to monitor all tasks (status, deps, questions). Statuses: \`running\`, \`waiting → <dep>\`, \`waiting_answer ⏸\`, \`completed\`, \`failed\`.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: buildPromptProperty(1000, 'Implementation brief. MUST include: OBJECTIVE (what to build), FILES TO MODIFY (absolute paths), SUCCESS CRITERIA (how to verify), CONSTRAINTS (what NOT to do), PATTERNS (existing code to follow). Min 1000 chars.'),
      context_files: buildContextFilesProperty('REQUIRED. ONLY .md files accepted — .ts/.js/.json will be rejected. Create specs via launch-super-planner first. Max 20 files, 200KB each, 500KB total.', { required: true }),
      ...baseInputSchemaProperties,
      model: buildModelProperty(`Model to use. Default: ${DEFAULT_MODEL}. Also accepts aliases: sonnet, opus, gpt-5.4, o4-mini, etc.`),
    },
    required: ['prompt', 'context_files'],
  },
  annotations: buildAnnotations('Launch Super Coder'),
  execution: SPAWN_TOOL_EXECUTION,
};

// --- Handler ---

export const handleLaunchSuperCoder = createLaunchHandler(
  LaunchSuperCoderSchema,
  'launch-super-coder',
  { toolName: 'coder', taskType: 'super-coder' },
);
