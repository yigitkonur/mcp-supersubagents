import { spawnCopilotTask } from '../services/sdk-spawner.js';
import { taskManager } from '../services/task-manager.js';
import { applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';
import { progressRegistry } from '../services/progress-registry.js';
import { TaskStatus, type ToolContext } from '../types.js';
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
  autonomous?: boolean;
  depends_on?: string[];
  labels?: string[];
}

export interface SpawnToolConfig {
  toolName: string;
  taskType?: TaskType;
  specialization?: string;
}

/**
 * Shared spawn handler used by all 4 specialized tools.
 * Performs: brief validation → context file assembly → template application → task spawn.
 */
export async function handleSharedSpawn(
  params: SharedSpawnParams,
  config: SpawnToolConfig,
  ctx?: ToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: true }> {
  // 1. Validate the brief
  const validation = validateBrief(config.toolName, params.prompt, params.context_files);
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

  // 3. Assemble prompt with context file contents
  const enrichedPrompt = assemblePromptWithContext(params.prompt, params.context_files);

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
      autonomous: params.autonomous,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
      taskType: config.taskType || 'super-coder',
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
