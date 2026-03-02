import { spawnCopilotTask } from '../services/sdk-spawner.js';
import { taskManager } from '../services/task-manager.js';
import { applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';
import { progressRegistry } from '../services/progress-registry.js';
import { TaskStatus, type ToolContext, type AgentMode, type ReasoningEffort } from '../types.js';
import { mcpText, mcpValidationError } from '../utils/format.js';
import {
  validateBrief,
  formatValidationError,
  assemblePromptWithContext,
  type ContextFile,
} from '../utils/brief-validator.js';

export interface SharedSpawnParams {
  prompt: string;
  context_files?: ContextFile[];
  model?: string;
  cwd?: string;
  timeout?: number;
  depends_on?: string[];
  labels?: string[];
  reasoning_effort?: ReasoningEffort;
  mode?: AgentMode;
}

export interface SpawnToolConfig {
  toolName: string;
  taskType?: TaskType;
  specialization?: string;
}

// Return type shared by all spawn handlers
export type SpawnHandlerResult = Promise<{ content: Array<{ type: string; text: string }>; isError?: true }>;

/**
 * Configuration for the generic spawn handler factory.
 */
export interface SpawnHandlerConfig<T> {
  schema: { parse: (args: unknown) => T };
  toolName: string;
  taskType?: TaskType;
  validationHint: string;
  getSpecialization?: (parsed: T) => string | undefined;
  getModel?: (parsed: T) => string | undefined;
  getTaskType?: (parsed: T) => TaskType | undefined;
}

/**
 * Generic factory that creates a spawn tool handler.
 * Eliminates identical boilerplate across spawn roles (coder, planner, tester, researcher).
 *
 * Each handler: parse → validate → map to SharedSpawnParams → call handleSharedSpawn.
 */
export function createSpawnHandler<T extends SharedSpawnParams>(
  config: SpawnHandlerConfig<T>,
): (args: unknown, ctx?: ToolContext) => SpawnHandlerResult {
  return async (args: unknown, ctx?: ToolContext): SpawnHandlerResult => {
    let parsed: T;
    try {
      parsed = config.schema.parse(args);
    } catch (error) {
      return mcpValidationError(
        `❌ **SCHEMA VALIDATION FAILED — ${config.toolName}**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}\n\n${config.validationHint}`
      );
    }

    return handleSharedSpawn(
      {
        prompt: parsed.prompt,
        context_files: parsed.context_files,
        model: config.getModel?.(parsed) ?? parsed.model,
        cwd: parsed.cwd,
        timeout: parsed.timeout,
        depends_on: parsed.depends_on,
        labels: parsed.labels,
        reasoning_effort: parsed.reasoning_effort,
        mode: parsed.mode,
      },
      {
        toolName: config.toolName,
        taskType: config.getTaskType?.(parsed) ?? config.taskType,
        specialization: config.getSpecialization?.(parsed),
      },
      ctx,
    );
  };
}

/**
 * Shared spawn handler used by all 5 specialized roles.
 * Performs: brief validation → context file assembly → template application → task spawn.
 */
export async function handleSharedSpawn(
  params: SharedSpawnParams,
  config: SpawnToolConfig,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  // 1. Validate the brief
  const validation = await validateBrief(config.toolName, params.prompt, params.context_files, params.cwd);
  if (!validation.valid) {
    return mcpValidationError(formatValidationError(config.toolName, validation.errors));
  }

  // 2. Validate dependencies if provided
  const dependsOn = params.depends_on?.filter((d: string) => d.trim()) || [];
  if (dependsOn.length > 0) {
    const depError = taskManager.validateDependencies(dependsOn);
    if (depError) {
      return mcpValidationError(
        `❌ **DEPENDENCY ERROR:** ${depError}\n\nEnsure all dependency task IDs exist. Read resource \`task:///all\` to find valid task IDs.`
      );
    }
  }

  // 3. Assemble prompt with context file contents (uses cached content from validation to avoid TOCTOU)
  const enrichedPrompt = await assemblePromptWithContext(params.prompt, params.context_files, validation.fileContents);

  // 4. Apply matryoshka template (base + specialization overlay)
  const finalPrompt = config.taskType && isValidTaskType(config.taskType)
    ? applyTemplate(config.taskType, enrichedPrompt, config.specialization)
    : enrichedPrompt;

  // 5. Spawn the task
  const labels = params.labels?.filter((l: string) => l.trim()) || [];

  try {
    const taskId = await spawnCopilotTask({
      prompt: finalPrompt,
      timeout: params.timeout,
      cwd: params.cwd,
      model: params.model,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
      taskType: config.taskType || 'super-coder',
      reasoningEffort: params.reasoning_effort,
      mode: params.mode,
    });

    const task = taskManager.getTask(taskId);
    const isWaiting = task?.status === TaskStatus.WAITING;

    if (ctx?.progressToken != null) {
      progressRegistry.register(taskId, ctx.progressToken, ctx.sendNotification);
      progressRegistry.sendProgress(taskId, `Task created: ${taskId}, status: ${task?.status || 'pending'}`);
    }

    if (isWaiting) {
      const depsList = dependsOn.map(d => `\`${d}\``).join(', ');
      const parts = [
        `✅ **Task queued (waiting for dependencies)**`,
        `task_id: \`${taskId}\``,
        task?.outputFilePath ? `output_file: \`${task.outputFilePath}\`` : null,
        '',
        `**Waiting on:** ${depsList}`,
        '',
        'Task will auto-start when dependencies complete. Continue with other work.',
      ].filter(Boolean);
      return mcpText(parts.join('\n'));
    }

    const parts = [
      `✅ **Task launched** (${config.toolName})`,
      `task_id: \`${taskId}\``,
      task?.outputFilePath ? `output_file: \`${task.outputFilePath}\`` : null,
      '',
      'The agent is working in the background. MCP notifications will alert on completion—no need to poll.',
      '',
      '**Optional progress check:**',
      task?.outputFilePath ? `- \`tail -20 ${task.outputFilePath}\` — Last 20 lines` : null,
      task?.outputFilePath ? `- \`wc -l ${task.outputFilePath}\` — Line count` : null,
      `- Read resource: \`task:///${taskId}\``,
    ].filter(Boolean);
    return mcpText(parts.join('\n'));
  } catch (error) {
    return mcpValidationError(
      `❌ **SPAWN ERROR:** ${error instanceof Error ? error.message : 'Unknown error'}\n\nCheck that all parameters are valid and try again.`
    );
  }
}
