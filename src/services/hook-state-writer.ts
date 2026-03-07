/**
 * Hook State Writer — persists task events to {cwd}/.super-agents/hook-state.json.
 *
 * A PostToolUse hook script reads unseen events from this file and injects them
 * as additionalContext into Claude Code's conversation. This gives mid-turn
 * reactivity without requiring MCP subscription support.
 *
 * Design:
 * - Map keyed by taskId (one event per task, latest wins)
 * - `seenAt: null` = unseen; hook script sets it to a timestamp
 * - Server reads before writing to preserve hook script's seenAt values
 * - Stale events (seenAt + 1 hour) are cleaned on read
 * - Atomic write: temp → fdatasync → rename (same as task-persistence.ts)
 * - Write coalescing with writeInProgress guard
 * - Error handling: swallow-tier (log to stderr, never throw)
 */

import { readFile, rename, open as openFile, mkdir, lstat } from 'fs/promises';
import { join } from 'path';
import { TaskState, TaskStatus, isTerminalStatus, PendingQuestion } from '../types.js';
import { mapInternalStatusToMCP } from './task-status-mapper.js';

const HOOK_STATE_FILE = 'hook-state.json';
const OUTPUT_DIR_NAME = '.super-agents';
const STALE_EVENT_AGE_MS = 60 * 60 * 1000; // 1 hour

interface HookEvent {
  type: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'input_required';
  taskId: string;
  status: string;
  outputFile?: string;
  prompt?: string;
  labels?: string[];
  question?: string;
  choices?: string[];
  occurredAt: string;
  seenAt: string | null;
}

interface HookStateFile {
  version: 1;
  events: Record<string, HookEvent>;
}

class HookStateWriter {
  private cwd: string | null = null;
  private knownDirExists = false;
  private writeInProgress = false;
  private pendingWrite = false;
  private pendingEvents: Map<string, HookEvent> = new Map();

  setCwd(cwd: string): void {
    if (cwd !== this.cwd) {
      this.knownDirExists = false;
    }
    this.cwd = cwd;
  }

  /**
   * Notify on terminal status changes. Only writes for terminal statuses.
   */
  async notifyStatusChange(task: TaskState): Promise<void> {
    if (!this.cwd || !isTerminalStatus(task.status)) return;

    const mcpStatus = mapInternalStatusToMCP(task.status);
    const type = this.statusToEventType(task.status);
    if (!type) return;

    const event: HookEvent = {
      type,
      taskId: task.id,
      status: mcpStatus,
      outputFile: task.outputFilePath,
      prompt: task.prompt ? task.prompt.slice(0, 200) : undefined,
      labels: task.labels,
      occurredAt: new Date().toISOString(),
      seenAt: null,
    };

    this.pendingEvents.set(task.id, event);
    await this.flush();
  }

  /**
   * Notify when a question is asked.
   */
  async notifyQuestion(taskId: string, question: PendingQuestion): Promise<void> {
    if (!this.cwd) return;

    const event: HookEvent = {
      type: 'input_required',
      taskId,
      status: 'input_required',
      question: question.question,
      choices: question.choices,
      occurredAt: new Date().toISOString(),
      seenAt: null,
    };

    this.pendingEvents.set(taskId, event);
    await this.flush();
  }

  private statusToEventType(status: TaskStatus): HookEvent['type'] | null {
    switch (status) {
      case TaskStatus.COMPLETED: return 'completed';
      case TaskStatus.FAILED: return 'failed';
      case TaskStatus.CANCELLED: return 'cancelled';
      case TaskStatus.TIMED_OUT: return 'timed_out';
      default: return null;
    }
  }

  private getFilePath(): string {
    return join(this.cwd!, OUTPUT_DIR_NAME, HOOK_STATE_FILE);
  }

  private async ensureDir(): Promise<boolean> {
    if (this.knownDirExists) return true;
    const dir = join(this.cwd!, OUTPUT_DIR_NAME);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stats = await lstat(dir);
      if (stats.isSymbolicLink()) {
        console.error('[hook-state] Output directory is a symlink, refusing to use');
        return false;
      }
      this.knownDirExists = true;
      return true;
    } catch (err) {
      console.error('[hook-state] Failed to create output dir:', err);
      return false;
    }
  }

  /**
   * Read existing state file, merging in pending events, then write atomically.
   * Preserves hook script's seenAt values and cleans stale events.
   */
  private async flush(): Promise<void> {
    if (this.writeInProgress) {
      this.pendingWrite = true;
      return;
    }
    this.writeInProgress = true;
    let eventsToWrite: Map<string, HookEvent> | undefined;

    try {
      if (!(await this.ensureDir())) return;

      // Drain pending events into a local snapshot
      eventsToWrite = new Map(this.pendingEvents);
      this.pendingEvents.clear();

      // Read existing state to preserve seenAt values from hook script
      let existing: HookStateFile = { version: 1, events: {} };
      try {
        const raw = await readFile(this.getFilePath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && typeof parsed.events === 'object') {
          existing = parsed;
        }
      } catch {
        // File doesn't exist or is corrupt — start fresh
      }

      const now = Date.now();

      // Merge: new events overwrite existing ones for the same taskId
      for (const [taskId, event] of eventsToWrite) {
        existing.events[taskId] = event;
      }

      // Clean stale events (seenAt + 1 hour)
      for (const [taskId, event] of Object.entries(existing.events)) {
        if (event.seenAt) {
          const seenAge = now - new Date(event.seenAt).getTime();
          if (seenAge > STALE_EVENT_AGE_MS) {
            delete existing.events[taskId];
          }
        }
      }

      // Atomic write: temp → fdatasync → rename
      const filePath = this.getFilePath();
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      const data = JSON.stringify(existing, null, 2) + '\n';

      const fh = await openFile(tmpPath, 'w', 0o600);
      try {
        await fh.writeFile(data);
        await fh.datasync();
      } finally {
        await fh.close();
      }
      await rename(tmpPath, filePath);
    } catch (err) {
      // Swallow-tier: log to stderr, never throw
      console.error('[hook-state] Failed to write state file:', err);
      // Re-queue events so the next flush can retry them
      if (eventsToWrite) {
        for (const [taskId, event] of eventsToWrite) {
          if (!this.pendingEvents.has(taskId)) {
            this.pendingEvents.set(taskId, event);
          }
        }
        this.pendingWrite = true;
      }
    } finally {
      this.writeInProgress = false;

      // If new events arrived during write, flush again
      if (this.pendingWrite) {
        this.pendingWrite = false;
        // Use setImmediate to avoid deep recursion
        setImmediate(() => {
          this.flush().catch(() => {});
        });
      }
    }
  }
}

export const hookStateWriter = new HookStateWriter();
