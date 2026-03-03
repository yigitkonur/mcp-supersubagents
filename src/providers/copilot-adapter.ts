/**
 * Copilot Provider Adapter
 *
 * Thin wrapper around the existing Copilot SDK infrastructure:
 * - sdk-spawner.ts (session creation, rotation)
 * - sdk-session-adapter.ts (event streaming, binding)
 * - sdk-client-manager.ts (client pool, session management)
 * - account-manager.ts (PAT token rotation)
 *
 * This adapter does NOT rewrite Copilot internals. It delegates to the
 * existing modules and exposes them through the ProviderAdapter interface.
 */

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSpawnOptions,
  AvailabilityResult,
} from './types.js';
import type { TaskHandle } from './task-handle.js';

const CAPABILITIES: ProviderCapabilities = {
  supportsSessionResume: true,
  supportsUserInput: true,
  supportsFleetMode: true,
  supportsCredentialRotation: true,
  maxConcurrency: Infinity, // Copilot manages concurrency via PTY FD recycling
};

export class CopilotProviderAdapter implements ProviderAdapter {
  readonly id = 'copilot';
  readonly displayName = 'GitHub Copilot SDK';

  checkAvailability(): AvailabilityResult {
    // Lazy import to avoid circular dependencies at module load time
    try {
      // accountManager is a singleton that's initialized in index.ts before providers
      const { accountManager } = require('../services/account-manager.js');
      const token = accountManager.getCurrentToken();
      if (!token) {
        return {
          available: false,
          reason: 'No PAT tokens configured or all tokens in cooldown',
        };
      }
      return { available: true };
    } catch {
      return { available: false, reason: 'Account manager not initialized' };
    }
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  async spawn(options: ProviderSpawnOptions, _handle?: TaskHandle): Promise<void> {
    // Lazy import to break circular dependency chain.
    // Copilot session runner manages state via sdk-spawner internals.
    // TaskHandle is accepted for interface conformance; the runner uses
    // taskManager directly until the Copilot SDK infrastructure is migrated.
    const { runCopilotSession } = await import('./copilot-session-runner.js');
    await runCopilotSession(options);
  }

  async abort(taskId: string, reason?: string): Promise<boolean> {
    const { sdkSessionAdapter } = await import('../services/sdk-session-adapter.js');
    const { processRegistry } = await import('../services/process-registry.js');

    sdkSessionAdapter.unbind(taskId);
    return processRegistry.killTask(taskId);
  }

  async sendMessage(taskId: string, message: string, options: ProviderSpawnOptions): Promise<string> {
    // NOTE: Unlike spawn(), sendMessage creates its own task via spawnCopilotTask()
    // rather than receiving a pre-created taskId. This is intentional — sendMessage
    // resumes an existing Copilot session, producing a new task. spawnCopilotTask()
    // handles session resumption and task state management internally.
    const { spawnCopilotTask } = await import('../services/sdk-spawner.js');
    const { taskManager } = await import('../services/task-manager.js');

    const originalTask = taskManager.getTask(taskId);

    const newTaskId = await spawnCopilotTask({
      prompt: message,
      timeout: options.timeout,
      cwd: options.cwd,
      resumeSessionId: originalTask?.sessionId,
      labels: [...(originalTask?.labels || []), `continued-from:${taskId}`],
    });

    return newTaskId;
  }

  async shutdown(): Promise<void> {
    const { shutdownSDK } = await import('../services/sdk-spawner.js');
    const { sdkSessionAdapter } = await import('../services/sdk-session-adapter.js');

    sdkSessionAdapter.cleanup();
    await shutdownSDK();
  }

  getStats(): Record<string, unknown> {
    try {
      const { getSDKStats } = require('../services/sdk-spawner.js');
      return getSDKStats();
    } catch {
      return { error: 'SDK stats unavailable' };
    }
  }
}
