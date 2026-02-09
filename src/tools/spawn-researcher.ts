import { SpawnResearcherSchema, RESEARCH_TYPES } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { createSpawnHandler } from './shared-spawn.js';

export const spawnResearcherTool = {
  name: 'spawn_researcher',
  description: `Spawn an autonomous research agent. Searches web, scrapes docs, analyzes Reddit, explores codebase. Evidence-based — every finding traces to a source.

**Required:** prompt (min 200 chars) with specific questions.

**Prompt must include:** WHAT TO RESEARCH (specific question), WHY IT MATTERS, WHAT'S ALREADY KNOWN, SPECIFIC QUESTIONS (2-5), HANDOFF TARGET.

**Creates:** \`.agent-workspace/researches/[topic]/\` with HANDOFF.md, recommendation, action-items.
Use HANDOFF.md as context_file when spawning planner/coder.

**Workflow:** spawn_researcher → spawn_planner → spawn_coder → spawn_tester. Use \`depends_on\` to chain.
Check status: \`task:///all\` or \`task:///{id}\``,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `Min 200 chars. Research brief with specific questions: WHAT TO RESEARCH, WHY IT MATTERS, WHAT'S KNOWN, SPECIFIC QUESTIONS (2-5), HANDOFF TARGET.`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to file.' },
            description: { type: 'string', description: 'What this file is.' },
          },
          required: ['path'],
        },
        description: `Optional. Attach code or docs for analysis. Max 20 files, 200KB each, 500KB total.`,
      },
      research_type: {
        type: 'string',
        enum: [...RESEARCH_TYPES],
        description: `Specialization: security (OWASP/CVE/STRIDE), library (comparison matrix, health signals), performance (benchmarks, profiling), architecture (design patterns). Default: general.`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Default: ${DEFAULT_MODEL}.`,
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

export const handleSpawnResearcher = createSpawnHandler({
  schema: SpawnResearcherSchema,
  toolName: 'spawn_researcher',
  taskType: 'super-researcher',
  validationHint: 'Required: `prompt` (min 200 chars) with specific questions to answer.',
  getSpecialization: (parsed) => parsed.research_type,
});
