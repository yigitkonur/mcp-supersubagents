import { SpawnTaskSchema } from '../utils/sanitize.js';
import { spawnCopilotTask } from '../services/sdk-spawner.js';
import { taskManager } from '../services/task-manager.js';
import { MODEL_IDS, DEFAULT_MODEL } from '../models.js';
import { TASK_TYPE_IDS, applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';
import { progressRegistry } from '../services/progress-registry.js';
import type { ToolContext } from '../types.js';
import { mcpText, formatError, join } from '../utils/format.js';

export const spawnTaskTool = {
  name: 'spawn_task',
  description: `Spawn an autonomous agent task. The agent runs isolated with NO shared memory -- your prompt is its ONLY context.

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
        description: `The complete, self-contained instructions for the spawned agent. This is the ONLY context the agent will have -- it cannot see your conversation history, previous tool calls, or any other context.

Your prompt MUST include:
- WHAT to do: Clear, specific objective (not vague like "fix the bug" -- say exactly which bug, which file, what the expected behavior is)
- WHERE to do it: All relevant file paths as absolute paths (e.g. /Users/dev/project/src/auth.ts, not just "auth.ts")
- HOW to verify: What does "done" look like? What tests to run? What to check?
- CONTEXT: Any background the agent needs -- error messages, stack traces, related code snippets, architectural decisions

BAD prompt: "Fix the login bug"
GOOD prompt: "In /Users/dev/myapp/src/services/auth.ts, the login() function on line 45 throws 'TypeError: Cannot read property email of undefined' when the user object is null. Fix the null check, ensure the function returns a proper error response for missing users, and verify by running: npm test -- --grep login"

The more detailed your prompt, the better the agent performs. Treat it as a complete brief for a developer who has never seen the codebase before.`,
      },
      task_type: {
        type: 'string',
        enum: TASK_TYPE_IDS,
        description: `Agent template that prepends specialized system instructions to your prompt.
- super-coder: For implementation tasks -- writing, editing, refactoring code
- super-planner: For architecture and design -- planning implementations, evaluating tradeoffs
- super-researcher: For investigation -- answering questions, finding code patterns, analyzing behavior
- super-tester: For QA -- writing tests, running test suites, verifying behavior`,
      },
      model: {
        type: 'string',
        enum: MODEL_IDS,
        description: `Model to use. Default: ${DEFAULT_MODEL}.
- claude-sonnet-4.5: Best balance of speed and capability (default, recommended for most tasks)
- claude-haiku-4.5: Fastest -- use for simple, well-defined tasks like running a single command or small edits
- claude-opus-4.5: Most capable -- use for complex reasoning, large refactors, or tasks requiring deep analysis`,
      },
      cwd: {
        type: 'string',
        description: `The absolute path to the working directory where the agent will execute. You should detect your current working directory and pass it here as a full absolute path. This is especially important when working in git worktrees -- pass the actual worktree path (e.g. /Users/dev/project/worktrees/feature-branch), NOT the main repository root. Do not create a new worktree just for this -- simply pass the directory you are currently working in.`,
      },
      timeout: {
        type: 'number',
        description: 'Optional. Max execution time in ms. Default: 1800000 (30 min, configurable via MCP_TASK_TIMEOUT_MS). Max: 3600000 (configurable via MCP_TASK_TIMEOUT_MAX_MS). Do NOT set unless necessary; prefer the default and only override for known long/short tasks.',
      },
      autonomous: {
        type: 'boolean',
        description: 'Run without interactive prompts. Default: true. Almost always leave this as true.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task starts. The task will wait in "waiting" status until all dependencies finish.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels for grouping and filtering tasks (max 10). Useful when managing multiple related tasks -- e.g. "auth-migration", "phase-1".',
      },
    },
    required: ['prompt'],
  },
};

export async function handleSpawnTask(args: unknown, ctx?: ToolContext): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    const parsed = SpawnTaskSchema.parse(args);

    // Validate dependencies if provided
    const dependsOn = parsed.depends_on?.filter((d: string) => d.trim()) || [];
    if (dependsOn.length > 0) {
      const validationError = taskManager.validateDependencies(dependsOn);
      if (validationError) {
        return mcpText(formatError(
          validationError,
          'Ensure all dependency task IDs exist.\nUse `list_tasks` to find valid task IDs.'
        ));
      }
    }

    let finalPrompt = parsed.prompt;
    if (parsed.task_type && isValidTaskType(parsed.task_type)) {
      finalPrompt = applyTemplate(parsed.task_type as TaskType, parsed.prompt);
    }

    const labels = parsed.labels?.filter((l: string) => l.trim()) || [];

    const taskId = await spawnCopilotTask({
      prompt: finalPrompt,
      timeout: parsed.timeout,
      cwd: parsed.cwd,
      model: parsed.model,
      autonomous: parsed.autonomous,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
    });

    const task = taskManager.getTask(taskId);
    const isWaiting = task?.status === 'waiting';

    if (ctx?.progressToken != null) {
      progressRegistry.register(taskId, ctx.progressToken, ctx.sendNotification);
      progressRegistry.sendProgress(taskId, `Task created: ${taskId}, status: ${task?.status || 'pending'}`);
    }

    if (isWaiting) {
      const depsList = dependsOn.map(d => `\`${d}\``).join(', ');
      return mcpText(join(
        `Task **${taskId}** spawned (waiting).`,
        `Depends on: ${depsList}`,
        '',
        'Dependencies must complete before this task runs.',
        'Check status with `get_status`.'
      ));
    }

    return mcpText(join(
      `Task **${taskId}** spawned (${task?.status || 'pending'}).`,
      'Check status with `get_status`.'
    ));
  } catch (error) {
    return mcpText(formatError(
      error instanceof Error ? error.message : 'Unknown error',
      'Check that the `prompt` parameter is provided and valid.'
    ));
  }
}
