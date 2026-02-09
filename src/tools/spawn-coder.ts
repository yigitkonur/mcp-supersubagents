import { SpawnCoderSchema, CODER_LANGUAGES } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { createSpawnHandler } from './shared-spawn.js';

export const spawnCoderTool = {
  name: 'spawn_coder',
  description: `Spawn an autonomous coding agent. Runs isolated — your brief + context_files are its ONLY context.

**Required:** prompt (min 1000 chars) + context_files (min 1 .md file).

**Prompt must include:** OBJECTIVE (what to build), FILES TO MODIFY (absolute paths), SUCCESS CRITERIA (testable), CONSTRAINTS (what NOT to do), PATTERNS TO FOLLOW (reference files).

**Cross-reference outputs:**
- Planner: \`.agent-workspace/plans/[topic]/05-handoff/builder-briefing.md\`
- Researcher: \`.agent-workspace/researches/[topic]/HANDOFF.md\`

**Workflow:** spawn_planner → spawn_coder → spawn_tester. Use \`depends_on\` to chain.
Check status: \`task:///all\` or \`task:///{id}\``,

  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `Min 1000 chars. Complete implementation brief: OBJECTIVE, FILES TO MODIFY (absolute paths), SUCCESS CRITERIA, CONSTRAINTS, PATTERNS TO FOLLOW, CONTEXT. Agent cannot see your conversation — everything must be in the prompt.`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to a .md file.' },
            description: { type: 'string', description: 'What this file contains.' },
          },
          required: ['path'],
        },
        description: `Min 1 Markdown (.md) file required. Attach planner handoffs, specs, or your own brief. Max 20 files, 200KB each, 500KB total.`,
      },
      language: {
        type: 'string',
        enum: [...CODER_LANGUAGES],
        description: `Language/framework specialization overlay. Languages: typescript, python, rust, go, java, ruby, swift, csharp, kotlin. Frameworks: react, nextjs, vue, supabase, tauri, triggerdev, supastarter. Default: general (infers from codebase).`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Default: ${DEFAULT_MODEL}. Use claude-haiku-4.5 for simple single-file changes.`,
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

export const handleSpawnCoder = createSpawnHandler({
  schema: SpawnCoderSchema,
  toolName: 'spawn_coder',
  taskType: 'super-coder',
  validationHint: 'Required: `prompt` (min 1000 chars) + `context_files` (min 1 .md file).',
  getSpecialization: (parsed) => parsed.language,
});
