import { z } from 'zod';
import { providerRegistry } from '../providers/registry.js';
import { triggerFallback } from '../providers/fallback-handler.js';
import { createTaskHandle } from '../providers/task-handle-impl.js';
import { taskManager } from '../services/task-manager.js';
import { applyTemplate, isValidTaskType, type TaskType } from '../templates/index.js';
import { progressRegistry } from '../services/progress-registry.js';
import { TaskStatus, isTerminalStatus, type ToolContext, type ReasoningEffort, type Provider } from '../types.js';
import { mcpText, mcpValidationError, type McpToolResponse } from '../utils/format.js';
import { resolveModel, getPreferredProvider, resolveModelForProvider, getEmbeddedReasoningEffort } from '../models.js';
import { clientContext } from '../services/client-context.js';
import { TASK_TIMEOUT_DEFAULT_MS } from '../config/timeouts.js';
import {
  validateBrief,
  formatValidationError,
  formatQualityWarnings,
  assemblePromptWithContext,
} from '../utils/brief-validator.js';
import { baseSpawnFields, contextFileSchema } from './spawn-schemas.js';

/**
 * Shared error recovery: attempt fallback, mark FAILED if no fallback available.
 * Used by spawn, retry, and execute paths to avoid duplicating the recovery chain.
 */
export async function recoverFromSpawnFailure(opts: {
  taskId: string;
  failedProviderId: Provider;
  reason: string;
  err: unknown;
  cwd: string;
  promptOverride: string;
}): Promise<void> {
  const { taskId, failedProviderId, reason, err, cwd, promptOverride } = opts;
  const errorMessage = err instanceof Error ? err.message : String(err);

  const currentTask = taskManager.getTask(taskId);
  if (!currentTask || isTerminalStatus(currentTask.status)) return;

  try {
    const fell = await triggerFallback({
      taskId,
      failedProviderId,
      reason,
      errorMessage,
      cwd,
      promptOverride,
    });
    if (!fell) {
      const t = taskManager.getTask(taskId);
      if (t && !isTerminalStatus(t.status)) {
        taskManager.updateTask(taskId, {
          status: TaskStatus.FAILED,
          error: `Provider '${failedProviderId}' failed: ${errorMessage}`,
          endTime: new Date().toISOString(),
          exitCode: 1,
        });
      }
    }
  } catch (fallbackErr) {
    console.error(`[shared-spawn] Fallback also failed for task ${taskId}:`, fallbackErr);
    const t = taskManager.getTask(taskId);
    if (t && !isTerminalStatus(t.status)) {
      taskManager.updateTask(taskId, {
        status: TaskStatus.FAILED,
        error: `Fallback failed for provider '${failedProviderId}': ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        endTime: new Date().toISOString(),
        exitCode: 1,
      });
    }
  }
}

/**
 * Factory for launch handlers — eliminates boilerplate across launch-super-*.ts files.
 * Each handler only needs to provide its schema, tool config, and optional param overrides.
 */
export function createLaunchHandler<T extends z.ZodType<Record<string, unknown>>>(
  schema: T,
  toolName: string,
  config: SpawnToolConfig,
  paramOverrides?: (parsed: z.infer<T>) => Partial<SharedSpawnParams>,
): (args: unknown, ctx?: ToolContext) => Promise<McpToolResponse> {
  return async (args: unknown, ctx?: ToolContext): Promise<McpToolResponse> => {
    let parsed: z.infer<T>;
    try {
      parsed = schema.parse(args);
    } catch (error) {
      return mcpValidationError(
        `**SCHEMA VALIDATION FAILED — ${toolName}**\n\n${error instanceof Error ? error.message : 'Invalid arguments'}`
      );
    }

    const params: SharedSpawnParams = {
      prompt: parsed.prompt as string,
      context_files: parsed.context_files as SharedSpawnParams['context_files'],
      model: parsed.model as SharedSpawnParams['model'],
      cwd: parsed.cwd as SharedSpawnParams['cwd'],
      timeout: parsed.timeout as SharedSpawnParams['timeout'],
      depends_on: parsed.depends_on as SharedSpawnParams['depends_on'],
      labels: parsed.labels as SharedSpawnParams['labels'],
      ...paramOverrides?.(parsed),
    };

    return handleSharedSpawn(params, config, ctx);
  };
}

const sharedSpawnSchema = z.object({
  ...baseSpawnFields,
  context_files: z.array(contextFileSchema).max(20).optional(),
});
export type SharedSpawnParams = z.infer<typeof sharedSpawnSchema>;

export type SpawnToolName = 'coder' | 'planner' | 'tester' | 'researcher' | 'general';

export interface SpawnToolConfig {
  toolName: SpawnToolName;
  taskType?: TaskType;
}

// Return type shared by all spawn handlers
export type SpawnHandlerResult = Promise<McpToolResponse>;

/**
 * Shared spawn handler used by all 5 specialized roles.
 * Performs: brief validation → context file assembly → template application → provider selection → task spawn.
 *
 * Task creation is provider-agnostic. The selected provider only handles
 * session execution (PENDING → RUNNING → COMPLETED|FAILED).
 */
export async function handleSharedSpawn(
  params: SharedSpawnParams,
  config: SpawnToolConfig,
  ctx?: ToolContext,
): Promise<McpToolResponse> {
  // 1. Validate the brief
  const validation = await validateBrief(config.toolName, params.prompt, params.context_files, params.cwd);
  if (!validation.valid) {
    return mcpValidationError(formatValidationError(config.toolName, validation.errors, validation.warnings));
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

  // 4. Apply role template
  const finalPrompt = config.taskType && isValidTaskType(config.taskType)
    ? applyTemplate(config.taskType, enrichedPrompt)
    : enrichedPrompt;

  // 5. Resolve model early so we can route to preferred provider
  const model = resolveModel(params.model, config.taskType);
  const selection = providerRegistry.selectProvider(getPreferredProvider(model), model);
  if (!selection) {
    return mcpValidationError(
      '❌ **NO PROVIDERS AVAILABLE:** No AI providers are configured or available.\n\n' +
      'Configure PAT tokens (GITHUB_PAT_TOKENS), OpenAI API key (OPENAI_API_KEY), or ensure Claude Agent SDK is enabled.'
    );
  }

  // 6. Create the task (provider-agnostic)
  const labels = params.labels?.filter((l: string) => l.trim()) || [];
  const cwd = params.cwd || clientContext.getDefaultCwd();
  const timeout = params.timeout ?? TASK_TIMEOUT_DEFAULT_MS;
  const taskType = config.taskType || 'super-coder';

  try {
    const task = taskManager.createTask(finalPrompt, cwd, model, {
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      labels: labels.length > 0 ? labels : undefined,
      provider: selection.provider.id,
      timeout,
      taskType,
    });

    const taskId = task.id;
    const isWaiting = task.status === TaskStatus.WAITING;

    if (ctx?.progressToken != null) {
      progressRegistry.register(taskId, ctx.progressToken, ctx.sendNotification);
      progressRegistry.sendProgress(taskId, `Task created: ${taskId}, status: ${task.status}`);
    }

    if (isWaiting) {
      const depsList = dependsOn.map(d => `\`${d}\``).join(', ');
      const parts = [
        `✅ **Task queued (waiting for dependencies)**`,
        `task_id: \`${taskId}\``,
        task.outputFilePath ? `output_file: \`${task.outputFilePath}\`` : null,
        '',
        `**Waiting on:** ${depsList}`,
        '',
        'Task will auto-start when dependencies complete. Continue with other work.',
      ].filter(Boolean);
      return mcpText(parts.join('\n'));
    }

    // 7. Start provider execution asynchronously (return task ID immediately)
    const selectedProvider = selection.provider;
    // Translate model name for the selected provider's SDK format
    const providerModel = resolveModelForProvider(model, selectedProvider.id);
    setImmediate(() => {
      // Guard: task may have been cancelled between creation and this callback
      const current = taskManager.getTask(taskId);
      if (!current || isTerminalStatus(current.status)) return;

      const handle = createTaskHandle(taskId);
      selectedProvider.spawn({
        taskId,
        prompt: finalPrompt,
        cwd,
        model: providerModel,
        timeout,
        reasoningEffort: getEmbeddedReasoningEffort(model) as ReasoningEffort | undefined,
        labels: labels.length > 0 ? labels : undefined,
        taskType,
      }, handle).catch((err) => {
        console.error(`[shared-spawn] Provider '${selectedProvider.id}' failed for task ${taskId}:`, err);
        recoverFromSpawnFailure({
          taskId,
          failedProviderId: selectedProvider.id,
          reason: `${selectedProvider.id}_spawn_error`,
          err,
          cwd,
          promptOverride: finalPrompt,
        });
      });
    });

    const qualityTip = formatQualityWarnings(validation.warnings);
    const parts = [
      `✅ **Task launched** (${config.toolName})`,
      `task_id: \`${taskId}\``,
      `provider: \`${selectedProvider.id}\` | model: \`${providerModel}\``,
      task.outputFilePath ? `output_file: \`${task.outputFilePath}\`` : null,
      '',
      'The agent is working in the background. MCP notifications will alert on completion—no need to poll.',
      '',
      '**Optional progress check:**',
      task.outputFilePath ? `- \`tail -20 ${task.outputFilePath}\` — Last 20 lines` : null,
      task.outputFilePath ? `- \`wc -l ${task.outputFilePath}\` — Line count` : null,
      `- Read resource: \`task:///${taskId}\``,
      qualityTip ? '' : null,
      qualityTip,
    ].filter(Boolean);
    return mcpText(parts.join('\n'));
  } catch (error) {
    return mcpValidationError(
      `❌ **SPAWN ERROR:** ${error instanceof Error ? error.message : 'Unknown error'}\n\nCheck that all parameters are valid and try again.`
    );
  }
}
