import { SpawnTesterSchema, TESTING_TYPES } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { createSpawnHandler } from './shared-spawn.js';

export const spawnTesterTool = {
  name: 'spawn_tester',
  description: `Spawn an autonomous QA agent. Tests via curl, Playwright, or existing test suites. Proves things work end-to-end.

**Required:** prompt (min 300 chars) + context_files (min 1 file).

**Prompt must include:** WHAT WAS BUILT, FILES CHANGED, SUCCESS CRITERIA (testable), TEST SUGGESTIONS, EDGE CASES, BASE URL/SETUP.

**Cross-reference:** Attach coder's HANDOFF.md or planner's tester-checklist.md as context_files.

**Workflow:** spawn_planner → spawn_coder → spawn_tester. Use \`depends_on\` to chain.
Check status: \`task:///all\` or \`task:///{id}\``,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `Min 300 chars. Testing brief: WHAT WAS BUILT, FILES CHANGED, SUCCESS CRITERIA, TEST SUGGESTIONS, EDGE CASES, BASE URL/SETUP.`,
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
        description: `Min 1 file. Attach code, handoffs, or test checklists. Any file type accepted. Max 20 files, 200KB each, 500KB total.`,
      },
      testing_type: {
        type: 'string',
        enum: [...TESTING_TYPES],
        description: `Specialization: playwright (browser/UI), rest (REST API curl), graphql (GraphQL API), suite (run existing tests), accessibility, performance, security. Default: general (auto-selects method).`,
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
    required: ['prompt', 'context_files'],
  },
};

export const handleSpawnTester = createSpawnHandler({
  schema: SpawnTesterSchema,
  toolName: 'spawn_tester',
  taskType: 'super-tester',
  validationHint: 'Required: `prompt` (min 300 chars) + `context_files` (min 1 file).',
  getSpecialization: (parsed) => parsed.testing_type,
});
