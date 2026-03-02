import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';

interface ProgressBinding {
  progressToken: string | number;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  progressCount: number;
  lastSendTime: number;
  pendingMessage: string | null;
  pendingTotal: number | undefined;
  flushTimer: NodeJS.Timeout | null;
}

const THROTTLE_MS = 100;

class ProgressRegistry {
  private bindings = new Map<string, ProgressBinding>();

  register(
    taskId: string,
    progressToken: string | number,
    sendNotification: (notification: ServerNotification) => Promise<void>,
  ): void {
    // Clean up any existing binding
    this.unregister(taskId);
    this.bindings.set(taskId.toLowerCase(), {
      progressToken,
      sendNotification,
      progressCount: 0,
      lastSendTime: 0,
      pendingMessage: null,
      pendingTotal: undefined,
      flushTimer: null,
    });
  }

  unregister(taskId: string): void {
    const key = taskId.toLowerCase();
    const binding = this.bindings.get(key);
    if (binding) {
      if (binding.flushTimer) {
        clearTimeout(binding.flushTimer);
      }
      // Flush any pending message before unregistering
      if (binding.pendingMessage) {
        this.doSend(binding, binding.pendingMessage);
      }
      this.bindings.delete(key);
    }
  }

  has(taskId: string): boolean {
    return this.bindings.has(taskId.toLowerCase());
  }

  sendProgress(taskId: string, message: string, total?: number): void {
    const binding = this.bindings.get(taskId.toLowerCase());
    if (!binding) return;

    const now = Date.now();
    const elapsed = now - binding.lastSendTime;

    // Always update pendingTotal to the most recent value
    if (total !== undefined) {
      binding.pendingTotal = total;
    }

    if (elapsed >= THROTTLE_MS) {
      // Send immediately
      if (binding.flushTimer) {
        clearTimeout(binding.flushTimer);
        binding.flushTimer = null;
      }
      // If there was a pending message, prepend it
      const fullMessage = binding.pendingMessage
        ? `${binding.pendingMessage}\n${message}`
        : message;
      binding.pendingMessage = null;
      const sendTotal = binding.pendingTotal;
      binding.pendingTotal = undefined;
      this.doSend(binding, fullMessage, sendTotal);
    } else {
      // Buffer the message
      binding.pendingMessage = binding.pendingMessage
        ? `${binding.pendingMessage}\n${message}`
        : message;

      // Schedule flush if not already scheduled
      if (!binding.flushTimer) {
        binding.flushTimer = setTimeout(() => {
          binding.flushTimer = null;
          if (binding.pendingMessage) {
            const msg = binding.pendingMessage;
            binding.pendingMessage = null;
            const sendTotal = binding.pendingTotal;
            binding.pendingTotal = undefined;
            this.doSend(binding, msg, sendTotal);
          }
        }, THROTTLE_MS);
        if (binding.flushTimer.unref) binding.flushTimer.unref();
      }
    }
  }

  clear(): void {
    for (const [, binding] of this.bindings) {
      if (binding.flushTimer) clearTimeout(binding.flushTimer);
    }
    this.bindings.clear();
  }

  private doSend(binding: ProgressBinding, message: string, total?: number): void {
    binding.progressCount++;
    binding.lastSendTime = Date.now();

    const notification: ServerNotification = {
      method: 'notifications/progress',
      params: {
        progressToken: binding.progressToken,
        progress: binding.progressCount,
        ...(total !== undefined ? { total } : {}),
        message,
      },
    };

    binding.sendNotification(notification).catch((err) => {
      console.error(`[progress-registry] Failed to send progress for token ${binding.progressToken}:`, err);
    });
  }
}

export const progressRegistry = new ProgressRegistry();
