/**
 * Central registry tracking all spawned child processes.
 * Used for:
 * - SIGTERM → SIGKILL escalation on cancel/timeout
 * - Server shutdown cleanup (kill all children)
 * - Crash recovery (process.on('exit') cleanup)
 * - Preventing zombie/orphan processes
 */

export interface TrackedProcess {
  taskId: string;
  pid: number;
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
    log(`registered pid=${entry.pid} task=${entry.taskId} label="${entry.label}"`);
  }

  /** Unregister (process exited normally) */
  unregister(taskId: string): void {
    const entry = this.processes.get(taskId);
    if (entry) {
      this.processes.delete(taskId);
      log(`unregistered pid=${entry.pid} task=${taskId}`);
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

    // Step 1: try session.abort() with 5s timeout
    if (session) {
      try {
        log(`killTask: aborting session for task=${taskId} pid=${pid}`);
        await Promise.race([
          session.abort(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('abort timeout')), 5000)
          ),
        ]);
        // Check if abort was sufficient
        if (!this.isAlive(pid)) {
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
        abortController.abort();
      } catch {}
    }

    // Step 2: SIGTERM
    if (!this.isAlive(pid)) {
      this.processes.delete(taskId);
      log(`killTask: pid=${pid} already dead before SIGTERM`);
      return true;
    }

    this.sendSignal(pid, pgid, 'SIGTERM');
    log(`killTask: sent SIGTERM to pid=${pid} task=${taskId}`);

    // Step 3: wait 3s
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    // Step 4: SIGKILL if still alive
    if (this.isAlive(pid)) {
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
      if (this.isAlive(entry.pid)) {
        this.sendSignal(entry.pid, entry.pgid, 'SIGTERM');
        log(`killAll: sent SIGTERM to pid=${entry.pid} task=${entry.taskId}`);
      }
      if (entry.abortController) {
        try { entry.abortController.abort(); } catch {}
      }
    }

    // Wait 5s
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));

    // SIGKILL stragglers
    for (const entry of entries) {
      if (this.isAlive(entry.pid)) {
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
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      if (err.code === 'ESRCH') return false;
      // EPERM means process exists but we lack permission — still alive
      if (err.code === 'EPERM') return true;
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
      try {
        if (entry.pgid) {
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
    pid: number,
    pgid: number | undefined,
    signal: NodeJS.Signals
  ): void {
    try {
      if (pgid) {
        process.kill(-pgid, signal);
      } else {
        process.kill(pid, signal);
      }
    } catch (err: any) {
      if (err.code !== 'ESRCH') {
        log(`sendSignal: error sending ${signal} to pid=${pid}: ${err.message}`);
      }
    }
  }
}

// Export singleton
export const processRegistry = new ProcessRegistry();
