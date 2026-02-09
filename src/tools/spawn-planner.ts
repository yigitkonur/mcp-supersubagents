import { SpawnPlannerSchema, PLANNING_TYPES } from '../utils/sanitize.js';
import { MODEL_IDS, OPUS_MODEL } from '../models.js';
import { createSpawnHandler } from './shared-spawn.js';

export const spawnPlannerTool = {
  name: 'spawn_planner',
  description: `Spawn an autonomous planning agent. Always uses ${OPUS_MODEL} regardless of model param.

**Required:** prompt (min 300 chars). Describe the PROBLEM, not the solution.

**Prompt must include:** PROBLEM STATEMENT, CONSTRAINTS, VERIFIED FACTS, SCOPE (in/out), EXPECTED OUTPUT.

**Creates:** \`.agent-workspace/plans/[topic]/\` with PLAN.md, builder-briefing.md, tester-checklist.md.
Use these as context_files when spawning coder/tester.

**Workflow:** spawn_planner → spawn_coder → spawn_tester. Use \`depends_on\` to chain.
Check status: \`task:///all\` or \`task:///{id}\``,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `Min 300 chars. Describe the PROBLEM (not solution): PROBLEM STATEMENT, CONSTRAINTS, VERIFIED FACTS, SCOPE, EXPECTED OUTPUT.`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to file.' },
            description: { type: 'string', description: 'What this file contains.' },
          },
          required: ['path'],
        },
        description: `Optional. Attach code, research findings, or architecture docs. Max 20 files, 200KB each, 500KB total.`,
      },
      planning_type: {
        type: 'string',
        enum: [...PLANNING_TYPES],
        description: `Specialization: feature (new feature), bugfix (root cause analysis), migration (incremental strategy), refactor (strangler fig), architecture (system design). Default: general.`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Ignored — always uses ${OPUS_MODEL}.`,
      },
      cwd: { type: 'string', description: 'Absolute path to working directory.' },
      timeout: { type: 'number', description: 'Max ms. Default: 1800000 (30min).' },
      autonomous: { type: 'boolean', description: 'Default: true.' },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete first.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for grouping (max 10).',
      },
    },
    required: ['prompt'],
  },
};

export const handleSpawnPlanner = createSpawnHandler({
  schema: SpawnPlannerSchema,
  toolName: 'spawn_planner',
  taskType: 'super-planner',
  validationHint: 'Required: `prompt` (min 300 chars). Describe the PROBLEM, not the solution.',
  getModel: () => OPUS_MODEL,
  getSpecialization: (parsed) => parsed.planning_type,
});
