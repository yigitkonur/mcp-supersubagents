import { SpawnTaskSchema } from '../utils/sanitize.js';
import { MODEL_IDS, DEFAULT_MODEL, OPUS_MODEL } from '../models.js';
import { TASK_TYPE_IDS, type TaskType } from '../templates/index.js';
import { createSpawnHandler } from './shared-spawn.js';

/**
 * Legacy spawn_task tool — kept for backward compatibility.
 * New clients should use the specialized tools: spawn_coder, spawn_planner, spawn_tester, spawn_researcher.
 */
export const spawnTaskTool = {
  name: 'spawn_task',
  description: `Spawn an autonomous agent task. The agent runs isolated with NO shared memory -- your prompt is its ONLY context.

⚠️ **PREFER THE SPECIALIZED TOOLS** for better guidance and validation:
• \`spawn_coder\` — Implementation tasks (requires detailed brief + .md context files)
• \`spawn_planner\` — Architecture & planning (always uses opus model)
• \`spawn_tester\` — QA & testing (requires context files)
• \`spawn_researcher\` — Investigation & research

This generic tool applies lighter validation. The specialized tools enforce structured briefs, mandatory context files, and provide task-specific guidance that produces dramatically better results.

**After spawning:** Check status via MCP Resources (not tools):
- \`task:///all\` → List all tasks with status
- \`task:///{id}\` → Full task details, output, metrics
- \`task:///{id}/session\` → Execution log with tool calls

**Task types:** super-coder (implementation), super-planner (architecture), super-researcher (investigation), super-tester (QA).
**Models:** ${MODEL_IDS.join(', ')}. Default: ${DEFAULT_MODEL}.

Account rotation and rate limit recovery happen automatically -- no manual intervention needed.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: `The complete, self-contained instructions for the spawned agent. This is the ONLY context the agent will have.

Your prompt MUST include:
- WHAT to do: Clear, specific objective
- WHERE to do it: All relevant file paths as absolute paths
- HOW to verify: What does "done" look like?
- CONTEXT: Background the agent needs

⚠️ For better results, use the specialized tools instead:
• spawn_coder (min 1,000 chars + .md files)
• spawn_planner (min 300 chars + problem description)
• spawn_tester (min 300 chars + context files)
• spawn_researcher (min 200 chars + specific questions)`,
      },
      task_type: {
        type: 'string',
        enum: TASK_TYPE_IDS,
        description: `Agent template. Use specialized tools (spawn_coder, etc.) for better validation.
- super-coder: Implementation — writing, editing, refactoring code
- super-planner: Architecture — planning implementations, evaluating tradeoffs
- super-researcher: Investigation — answering questions, analyzing behavior
- super-tester: QA — testing, running test suites, verifying behavior`,
      },
      context_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to a context file.' },
            description: { type: 'string', description: 'What this file is and why it matters.' },
          },
          required: ['path'],
        },
        description: 'Optional context files. Their contents are read and injected into the prompt.',
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}. super-planner always uses ${OPUS_MODEL}.`,
      },
      cwd: {
        type: 'string',
        description: 'Absolute path to the working directory.',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in ms. Default: 1800000 (30 min).',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without interactive prompts. Default: true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for grouping and filtering tasks (max 10).',
      },
    },
    required: ['prompt'],
  },
};

export const handleSpawnTask = createSpawnHandler({
  schema: SpawnTaskSchema,
  toolName: 'spawn_task',
  validationHint: '💡 **TIP:** Use the specialized tools for better guidance:\n• `spawn_coder` — Implementation tasks\n• `spawn_planner` — Planning tasks\n• `spawn_tester` — Testing tasks\n• `spawn_researcher` — Research tasks',
  getTaskType: (parsed) => parsed.task_type ? (parsed.task_type as TaskType) : undefined,
});
