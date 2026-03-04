/**
 * Central registry tracking all spawned child processes.
 * Used for:
 * - SIGTERM → SIGKILL escalation on cancel/timeout
 * - Server shutdown cleanup (kill all children)
 * - Crash recovery (process.on('exit') cleanup)
 * - Preventing zombie/orphan processes
 */

import { isErrnoException } from '../utils/is-errno-exception.js';

export interface TrackedProcess {
  taskId: string;
  pid?: number;
  /** Process group ID if available (for killing entire tree) */
  pgid?: number;
  /** AbortController if this is an SDK session */
  abortController?: AbortController;
  /** SDK session reference for abort() */
  session?: { abort: () => Promise<void> };
  /** Timestamp when registered */
  registeredAt: number;
  /** Label for logging */
  label: string;
}

function log(msg: string): void {
  console.error(`[process-registry] ${msg}`);
}

export class ProcessRegistry {
  private processes: Map<string, TrackedProcess> = new Map();

  /** Register a child process. Key is taskId. */
  register(entry: TrackedProcess): void {
    this.processes.set(entry.taskId, entry);
    log(`registered pid=${entry.pid ?? 'n/a'} task=${entry.taskId} label="${entry.label}"`);
  }

  /** Unregister (process exited normally) */
  unregister(taskId: string): void {
    const entry = this.processes.get(taskId);
    if (entry) {
      this.processes.delete(taskId);
      log(`unregistered pid=${entry.pid ?? 'n/a'} task=${taskId}`);
    }
  }

  /** Get tracked process by taskId */
  get(taskId: string): TrackedProcess | undefined {
    return this.processes.get(taskId);
  }

  /** Get all tracked processes */
  getAll(): TrackedProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Kill a specific task's process with escalation:
   * 1. Try session.abort() with 5s timeout
   * 2. Send SIGTERM to PID
   * 3. Wait 3s
   * 4. Send SIGKILL if still alive
   * Returns true if process was killed
   */
  async killTask(taskId: string): Promise<boolean> {
    const entry = this.processes.get(taskId);
    if (!entry) {
      log(`killTask: no tracked process for task=${taskId}`);
      return false;
    }

    const { pid, pgid, session, abortController } = entry;
    const hasPid = this.hasValidPid(pid);
    let handledWithoutSignal = false;

    // Step 1: try session.abort() with 5s timeout
    if (session) {
      try {
        log(`killTask: aborting session for task=${taskId} pid=${pid ?? 'n/a'}`);
        await Promise.race([
          session.abort(),
          new Promise<void>((_, reject) => {
            const timeout = setTimeout(() => reject(new Error('abort timeout')), 5000);
            timeout.unref();
          }),
        ]);
        handledWithoutSignal = true;
        // Check if abort was sufficient
        if (!hasPid || !this.isAlive(pid, pgid)) {
          this.processes.delete(taskId);
          log(`killTask: session.abort() succeeded for task=${taskId}`);
          return true;
        }
      } catch (err) {
        log(`killTask: session.abort() failed/timed out for task=${taskId}: ${err}`);
      }
    }

    // Signal the AbortController if present
    if (abortController) {
      try {
        abortController.abort('cancelled');
        handledWithoutSignal = true;
      } catch {}
    }

    if (!hasPid) {
      this.processes.delete(taskId);
      if (handledWithoutSignal) {
        log(`killTask: handled via session/abortController for task=${taskId} (no pid)`);
        return true;
      }
      log(`killTask: no valid pid/session/abortController for task=${taskId}`);
      return false;
    }

    // Step 2: SIGTERM
    if (!this.isAlive(pid, pgid)) {
      this.processes.delete(taskId);
      log(`killTask: pid=${pid} already dead before SIGTERM`);
      return true;
    }

    this.sendSignal(pid, pgid, 'SIGTERM');
    log(`killTask: sent SIGTERM to pid=${pid} task=${taskId}`);

    // Step 3: wait 3s
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      timeout.unref();
    });

    // Step 4: SIGKILL if still alive
    if (this.isAlive(pid, pgid)) {
      this.sendSignal(pid, pgid, 'SIGKILL');
      log(`killTask: sent SIGKILL to pid=${pid} task=${taskId}`);
    } else {
      log(`killTask: pid=${pid} exited after SIGTERM`);
    }

    this.processes.delete(taskId);
    return true;
  }

  /**
   * Kill ALL tracked processes (for server shutdown).
   * Uses SIGTERM first, waits 5s, then SIGKILL for stragglers.
   */
  async killAll(): Promise<void> {
    const entries = this.getAll();
    if (entries.length === 0) {
      log('killAll: no tracked processes');
      return;
    }

    log(`killAll: terminating ${entries.length} tracked processes`);

    // SIGTERM all
    for (const entry of entries) {
      if (entry.session) {
        entry.session.abort().catch(() => {});
      }
      if (this.isAlive(entry.pid, entry.pgid)) {
        this.sendSignal(entry.pid, entry.pgid, 'SIGTERM');
        log(`killAll: sent SIGTERM to pid=${entry.pid} task=${entry.taskId}`);
      }
      if (entry.abortController) {
        try { entry.abortController.abort('cancelled'); } catch {}
      }
    }

    // Wait 5s
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      timeout.unref();
    });

    // SIGKILL stragglers
    for (const entry of entries) {
      if (this.isAlive(entry.pid, entry.pgid)) {
        this.sendSignal(entry.pid, entry.pgid, 'SIGKILL');
        log(`killAll: sent SIGKILL to straggler pid=${entry.pid} task=${entry.taskId}`);
      }
    }

    this.processes.clear();
    log('killAll: complete');
  }

  /**
   * Check if a PID is still alive
   */
  isAlive(pid?: number, pgid?: number): boolean {
    if (!this.hasValidPid(pid) && !this.hasValidPid(pgid)) return false;
    try {
      if (this.hasValidPid(pgid)) {
        process.kill(-pgid, 0);
      } else if (this.hasValidPid(pid)) {
        process.kill(pid, 0);
      } else {
        return false;
      }
      return true;
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === 'ESRCH') return false;
      // EPERM means process exists but we lack permission — still alive
      if (isErrnoException(err) && err.code === 'EPERM') return true;
      return false;
    }
  }

  /** Number of tracked processes */
  get size(): number {
    return this.processes.size;
  }

  /**
   * Synchronous cleanup for process.on('exit') handler.
   * Uses SIGKILL directly since we can't await.
   */
  killAllSync(): void {
    const entries = this.getAll();
    if (entries.length === 0) return;

    log(`killAllSync: force-killing ${entries.length} tracked processes`);

    for (const entry of entries) {
      if (entry.abortController) {
        try { entry.abortController.abort('cancelled'); } catch {}
      }
      if (!this.hasValidPid(entry.pid)) {
        continue;
      }
      try {
        if (this.hasValidPid(entry.pgid)) {
          process.kill(-entry.pgid, 'SIGKILL');
        } else {
          process.kill(entry.pid, 'SIGKILL');
        }
      } catch {
        // Process already dead or ESRCH — ignore
      }
    }

    this.processes.clear();
  }

  /** Send a signal to pid or process group */
  private sendSignal(
    pid: number | undefined,
    pgid: number | undefined,
    signal: NodeJS.Signals
  ): void {
    if (!this.hasValidPid(pid) && !this.hasValidPid(pgid)) {
      return;
    }
    try {
      if (this.hasValidPid(pgid)) {
        process.kill(-pgid, signal);
      } else if (this.hasValidPid(pid)) {
        process.kill(pid, signal);
      }
    } catch (err: unknown) {
      if (!isErrnoException(err) || err.code !== 'ESRCH') {
        const msg = err instanceof Error ? err.message : String(err);
        log(`sendSignal: error sending ${signal} to pid=${pid ?? 'n/a'}: ${msg}`);
      }
    }
  }

  private hasValidPid(pid: number | undefined): pid is number {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  }
}

// Export singleton
export const processRegistry = new ProcessRegistry();
