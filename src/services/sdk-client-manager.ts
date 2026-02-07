/**
 * SDK Client Manager - Manages CopilotClient instances for the MCP server.
 * 
 * Provides a singleton pattern for managing Copilot SDK clients per workspace,
 * handling authentication, lifecycle, and multi-account PAT token rotation.
 * 
 * Multi-Account Support:
 * - Integrates with AccountManager for round-robin PAT token rotation
 * - Automatically switches tokens on rate limit (429) or server errors (5xx)
 * - Resets to first token on MCP reconnect
 * 
 * User Input (ask_user) Support:
 * - Registers onUserInputRequest handler for SDK questions
 * - Forwards questions to QuestionRegistry for MCP client handling
 */

import { CopilotClient, type CopilotClientOptions, type CopilotSession, type SessionConfig, type UserInputRequest, type UserInputResponse } from '@github/copilot-sdk';
import { execSync } from 'node:child_process';
import { accountManager } from './account-manager.js';
import { questionRegistry } from './question-registry.js';
import { createSessionHooks } from './session-hooks.js';
import { taskManager, TERMINAL_STATUSES } from './task-manager.js';

const COPILOT_PATH = process.env.COPILOT_PATH || '/opt/homebrew/bin/copilot';

const PTY_RECYCLE_THRESHOLD = 80;
const DESTROY_SESSION_TIMEOUT_MS = 10_000;
const CLIENT_START_TIMEOUT_MS = 30_000;
const CLIENT_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const RECYCLE_STOP_TIMEOUT_MS = 10_000;
const SHUTDOWN_STOP_TIMEOUT_MS = 15_000;
const STALE_SESSION_CLEANUP_INTERVAL_MS = 60_000;

interface ClientEntry {
  client: CopilotClient;
  cwd: string;
  tokenIndex: number;
  createdAt: Date;
  lastUsedAt: Date;
  sessions: Map<string, CopilotSession>;
}

/**
 * Generic timeout wrapper for SDK operations that can hang.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Retry-with-backoff wrapper for session.destroy(), matching the SDK's own
 * 3-attempt exponential backoff pattern used in stop().
 */
async function destroySessionWithRetry(
  session: CopilotSession,
  sessionId: string,
  totalTimeoutMs: number,
): Promise<void> {
  return withTimeout(
    (async () => {
      const MAX_ATTEMPTS = 3;
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await session.destroy();
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
          }
        }
      }
      throw lastError!;
    })(),
    totalTimeoutMs,
    `destroy session ${sessionId} (with retries)`,
  );
}

/**
 * Create a user input handler that forwards questions to the QuestionRegistry.
 * This enables SDK's ask_user tool to pause and wait for MCP client response.
 */
function createUserInputHandler(taskId: string): (request: UserInputRequest, invocation: { sessionId: string }) => Promise<UserInputResponse> {
  return async (request: UserInputRequest, invocation: { sessionId: string }): Promise<UserInputResponse> => {
    console.error(`[sdk-client-manager] User input requested for task ${taskId}, session ${invocation.sessionId}: "${request.question}"`);
    
    // Register question and wait for answer via QuestionRegistry
    const response = await questionRegistry.register(
      taskId,
      invocation.sessionId,
      request.question,
      request.choices,
      request.allowFreeform ?? true
    );
    
    return response;
  };
}

class SDKClientManager {
  private clients: Map<string, ClientEntry> = new Map();
  private pendingClients: Map<string, Promise<CopilotClient>> = new Map(); // RC-3: Dedup concurrent getClient calls
  private isShuttingDown = false;
  private staleSessionTimer: ReturnType<typeof setInterval> | null = null;
  private sweepCycle = 0;

  /**
   * Initialize the client manager (call on MCP connect).
   * Initializes the account manager and resets to first token.
   */
  initialize(): void {
    accountManager.initialize();
    this.startStaleSessionSweeper();
    console.error(`[sdk-client-manager] Initialized with ${accountManager.getTokenCount()} account(s)`);
  }

  /**
   * Reset the client manager (call on MCP reconnect).
   * Clears all clients and resets account rotation to first token.
   */
  async reset(): Promise<void> {
    this.pendingClients.clear();

    // Clear our tracking first — let SDK stop() handle session cleanup
    for (const entry of this.clients.values()) {
      entry.sessions.clear();
    }

    for (const [key, entry] of this.clients) {
      try {
        await withTimeout(entry.client.stop(), SHUTDOWN_STOP_TIMEOUT_MS, `stop client ${key}`);
      } catch {
        try { await entry.client.forceStop(); } catch { /* ignore */ }
      }
    }
    this.clients.clear();

    accountManager.reset();
    console.error('[sdk-client-manager] Reset complete - all clients cleared, starting from first account');
  }

  /**
   * Get or create a CopilotClient for the given workspace.
   * Uses the current token from account manager.
   */
  async getClient(cwd: string): Promise<CopilotClient> {
    if (this.isShuttingDown) {
      throw new Error('SDK client manager is shutting down');
    }

    const currentToken = accountManager.getCurrentToken();
    const tokenIndex = accountManager.getCurrentIndex();
    const clientKey = `${cwd}:${tokenIndex}`;

    // Fast path: client already exists
    const entry = this.clients.get(clientKey);
    if (entry) {
      entry.lastUsedAt = new Date();
      return entry.client;
    }

    // RC-3: Check if creation is already in progress for this key
    const pending = this.pendingClients.get(clientKey);
    if (pending) {
      return pending;
    }

    // Create with dedup — store the promise so concurrent callers reuse it
    const promise = this.createClient(cwd, currentToken).then(client => {
      // Guard: if reset/shutdown invalidated this creation, stop the orphaned client
      if (this.isShuttingDown || this.pendingClients.get(clientKey) !== promise) {
        client.stop?.().catch(() => {});
        throw new Error('Client creation invalidated by reset/shutdown');
      }
      this.clients.set(clientKey, {
        client,
        cwd,
        tokenIndex,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        sessions: new Map(),
      });
      this.pendingClients.delete(clientKey);
      console.error(`[sdk-client-manager] Created client for cwd=${cwd} with token #${tokenIndex + 1}/${accountManager.getTokenCount()}`);
      return client;
    }).catch(err => {
      this.pendingClients.delete(clientKey);
      throw err;
    });

    this.pendingClients.set(clientKey, promise);
    return promise;
  }

  /**
   * Create a new CopilotClient with the specified configuration.
   */
  private async createClient(cwd: string, githubToken?: string): Promise<CopilotClient> {
    const options: CopilotClientOptions = {
      cliPath: COPILOT_PATH,
      cwd,
      logLevel: 'error',
      autoStart: true,
      autoRestart: false,
      useStdio: false,  // TCP mode: avoids macOS stdio pipe destruction race
    };

    if (githubToken) {
      options.githubToken = githubToken;
      options.useLoggedInUser = false;
    }

    const client = new CopilotClient(options);
    await withTimeout(client.start(), CLIENT_START_TIMEOUT_MS, 'client.start()');
    return client;
  }

  /**
   * Create a session using the SDK client for the given workspace.
   * Includes user input handler for SDK ask_user tool support.
   */
  async createSession(
    cwd: string,
    sessionId: string,
    config: Omit<SessionConfig, 'sessionId'>,
    taskId?: string
  ): Promise<CopilotSession> {
    const client = await this.getClient(cwd);
    const tokenIndex = accountManager.getCurrentIndex();
    const clientKey = `${cwd}:${tokenIndex}`;

    // Build session config with user input handler and hooks if taskId provided
    const sessionConfig: SessionConfig = {
      sessionId,
      ...config,
    };

    // Add user input handler and session hooks when taskId is provided
    if (taskId) {
      sessionConfig.onUserInputRequest = createUserInputHandler(taskId);
      // Wire SDK session hooks for lifecycle events, error handling, and tool telemetry
      sessionConfig.hooks = createSessionHooks(taskId);
    }

    const session = await client.createSession(sessionConfig);

    // Track the session in the client entry
    const entry = this.clients.get(clientKey);
    if (entry) {
      entry.sessions.set(sessionId, session);
    }

    return session;
  }

  /**
   * Resume an existing session.
   * Includes user input handler for SDK ask_user tool support.
   */
  async resumeSession(
    cwd: string,
    sessionId: string,
    config?: Partial<SessionConfig>,
    taskId?: string
  ): Promise<CopilotSession> {
    const client = await this.getClient(cwd);

    // Capture token index BEFORE the async resumeSession call to prevent
    // tracking drift if token rotation happens during the await
    const tokenIndex = accountManager.getCurrentIndex();
    const clientKey = `${cwd}:${tokenIndex}`;

    // Build resume config with user input handler and hooks if taskId provided
    const resumeConfig: Partial<SessionConfig> = { ...config };

    if (taskId) {
      resumeConfig.onUserInputRequest = createUserInputHandler(taskId);
      // Wire SDK session hooks for lifecycle events, error handling, and tool telemetry
      resumeConfig.hooks = createSessionHooks(taskId);
    }

    const session = await client.resumeSession(sessionId, resumeConfig);

    // Track the resumed session in the client entry
    const entry = this.clients.get(clientKey);
    if (entry) {
      entry.sessions.set(sessionId, session);
    }

    return session;
  }

  /**
   * Get an active session by ID.
   */
  getSession(sessionId: string): CopilotSession | undefined {
    for (const entry of this.clients.values()) {
      const session = entry.sessions.get(sessionId);
      if (session) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Destroy a session and remove it from tracking.
   */
  async destroySession(sessionId: string): Promise<boolean> {
    for (const entry of this.clients.values()) {
      const session = entry.sessions.get(sessionId);
      if (session) {
        // Delete from tracking first to prevent double-destroy race with sweeper
        entry.sessions.delete(sessionId);
        try {
          await destroySessionWithRetry(session, sessionId, DESTROY_SESSION_TIMEOUT_MS);
        } catch (err) {
          console.error(`[sdk-client-manager] Failed to destroy session ${sessionId}:`, err);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Abort a running session.
   */
  async abortSession(sessionId: string): Promise<boolean> {
    const session = this.getSession(sessionId);
    if (session) {
      try {
        await session.abort();
        return true;
      } catch (err) {
        console.error(`[sdk-client-manager] Failed to abort session ${sessionId}:`, err);
      }
    }
    return false;
  }

  /**
   * Rotate to the next account on error.
   * Returns the new client if rotation was successful.
   * 
   * @param cwd - Workspace directory
   * @param reason - Reason for rotation (e.g., 'rate_limit_429', 'server_error_500')
   */
  async rotateOnError(cwd: string, reason: string): Promise<{ success: boolean; client?: CopilotClient; error?: string; allExhausted?: boolean }> {
    const result = accountManager.rotateToNext(reason);

    if (!result.success) {
      if (result.allExhausted) {
        return {
          success: false,
          allExhausted: true,
          error: `All ${accountManager.getTokenCount()} accounts exhausted: ${result.error}`
        };
      }
      return { success: false, error: result.error };
    }

    // Get client with new token
    try {
      const client = await this.getClient(cwd);
      console.error(`[sdk-client-manager] Rotated to token #${result.tokenIndex! + 1} due to: ${reason}`);

      // RC-7: Clean up stale clients from previous tokens
      this.cleanupStaleClients();

      return { success: true, client };
    } catch (err) {
      return {
        success: false,
        error: `Failed to create client with new token: ${err}`
      };
    }
  }

  /**
   * RC-7: Remove client entries with no active sessions that belong to non-current tokens.
   * Prevents gradual resource leak from accumulated stale clients after rotation.
   */
  private cleanupStaleClients(): void {
    const currentIndex = accountManager.getCurrentIndex();
    for (const [key, entry] of this.clients.entries()) {
      if (entry.tokenIndex !== currentIndex && entry.sessions.size === 0) {
        entry.client.stop?.().catch(() => {});
        this.clients.delete(key);
        console.error(`[sdk-client-manager] Cleaned up stale client: ${key}`);
      }
    }
  }

  /**
   * Start the periodic stale-session sweeper. Timer is unref()'d so it
   * doesn't prevent the process from exiting.
   */
  private startStaleSessionSweeper(): void {
    if (this.staleSessionTimer) return;
    this.staleSessionTimer = setInterval(() => {
      this.sweepStaleSessions().catch((err) => {
        console.error('[sdk-client-manager] Sweeper error:', err);
      });
    }, STALE_SESSION_CLEANUP_INTERVAL_MS);
    this.staleSessionTimer.unref();
    console.error('[sdk-client-manager] Stale-session sweeper started');
  }

  /**
   * Ping each client to detect dead/crashed CLI processes. Removes dead
   * clients from the pool and force-stops them.
   */
  private async checkClientHealth(): Promise<void> {
    for (const [key, entry] of this.clients.entries()) {
      try {
        await withTimeout(
          entry.client.ping('health'),
          CLIENT_HEALTH_CHECK_TIMEOUT_MS,
          `ping client ${key}`,
        );
      } catch {
        console.error(`[sdk-client-manager] Health check failed for client ${key}, removing dead client`);
        entry.sessions.clear();
        this.clients.delete(key);
        try { await entry.client.forceStop(); } catch { /* already dead */ }
      }
    }
  }

  /**
   * Sweep all tracked sessions. If the corresponding task (looked up by
   * sessionId which equals taskId by convention) is terminal or missing,
   * destroy the session with a timeout. Then recycle PTY leakers.
   */
  private async sweepStaleSessions(): Promise<void> {
    // Remove dead clients first so we don't try to destroy sessions on them
    await this.checkClientHealth();

    let destroyed = 0;
    for (const entry of this.clients.values()) {
      for (const [sessionId, session] of entry.sessions) {
        const task = taskManager.getTask(sessionId);
        if (!task || TERMINAL_STATUSES.has(task.status as any)) {
          entry.sessions.delete(sessionId);
          try {
            await withTimeout(
              entry.client.deleteSession(sessionId),
              DESTROY_SESSION_TIMEOUT_MS,
              `delete session ${sessionId}`,
            );
          } catch {
            // Fall back to local destroy if deleteSession fails
            try {
              await destroySessionWithRetry(session, sessionId, DESTROY_SESSION_TIMEOUT_MS);
            } catch (err) {
              console.error(`[sdk-client-manager] Sweeper: destroy failed for ${sessionId}: ${err}`);
            }
          }
          destroyed++;
        }
      }
    }
    if (destroyed > 0) {
      console.error(`[sdk-client-manager] Sweeper: destroyed ${destroyed} stale session(s)`);
    }

    // Every 5th sweep cycle, detect and clean up orphaned server-side sessions
    this.sweepCycle++;
    if (this.sweepCycle % 5 === 0) {
      await this.detectOrphanedSessions();
    }

    await this.recyclePtyLeakers();
  }

  /**
   * Detect server-side sessions that we're not tracking locally (orphaned from
   * crashes). Uses listSessions() and deletes any not in our tracking map.
   */
  private async detectOrphanedSessions(): Promise<void> {
    for (const [key, entry] of this.clients.entries()) {
      try {
        const serverSessions = await withTimeout(
          entry.client.listSessions(),
          CLIENT_HEALTH_CHECK_TIMEOUT_MS,
          `listSessions ${key}`,
        );
        const trackedIds = new Set(entry.sessions.keys());
        for (const meta of serverSessions) {
          if (!trackedIds.has(meta.sessionId)) {
            console.error(`[sdk-client-manager] Sweeper: deleting orphaned session ${meta.sessionId}`);
            try { await entry.client.deleteSession(meta.sessionId); } catch { /* best effort */ }
          }
        }
      } catch { /* listSessions failure is non-fatal */ }
    }
  }

  /**
   * For each client entry, check PTY FD count via lsof. If count exceeds
   * threshold and no active sessions remain, recycle the client (stop it
   * and remove from map so the next getClient() creates a fresh one).
   */
  private async recyclePtyLeakers(): Promise<void> {
    for (const [key, entry] of this.clients.entries()) {
      // Skip dead clients — health check will handle cleanup
      try {
        await withTimeout(entry.client.ping('recycle-check'), 3_000, `ping ${key}`);
      } catch {
        continue;
      }

      // SDK has no public API for process PID or FD count.
      // cliProcess is private (client.ts:121). This cast is the only way
      // to count ptmx FDs until the SDK adds a resource health endpoint.
      const pid = (entry.client as any).cliProcess?.pid as number | undefined;
      if (!pid) continue;

      let ptmxCount = 0;
      try {
        const output = execSync(`lsof -p ${pid} 2>/dev/null | grep -c ptmx`, {
          encoding: 'utf8',
          timeout: 5_000,
        });
        ptmxCount = parseInt(output.trim(), 10) || 0;
      } catch {
        // grep returns exit code 1 when no matches → ptmxCount stays 0
        continue;
      }

      if (ptmxCount > PTY_RECYCLE_THRESHOLD && entry.sessions.size === 0) {
        console.error(`[sdk-client-manager] Sweeper: recycling client ${key} (${ptmxCount} ptmx FDs, 0 active sessions)`);
        // Escalating shutdown: graceful → force
        try {
          await withTimeout(entry.client.stop(), RECYCLE_STOP_TIMEOUT_MS, `stop client ${key}`);
        } catch (stopErr) {
          console.error(`[sdk-client-manager] Sweeper: graceful stop failed for ${key}, forcing: ${stopErr}`);
          try { await entry.client.forceStop(); } catch { /* ignore */ }
        }
        this.clients.delete(key);
      }
    }
  }

  /**
   * Check if rotation should happen based on error.
   */
  shouldRotateOnError(statusCode?: number, errorMessage?: string): boolean {
    return accountManager.shouldRotate(statusCode, errorMessage);
  }

  /**
   * Check authentication status for current token.
   */
  async checkAuthStatus(cwd: string): Promise<{ isAuthenticated: boolean; login?: string; tokenIndex: number }> {
    try {
      const client = await this.getClient(cwd);
      const status = await client.getAuthStatus();
      return {
        isAuthenticated: status.isAuthenticated,
        login: status.login,
        tokenIndex: accountManager.getCurrentIndex(),
      };
    } catch (err) {
      console.error('[sdk-client-manager] Auth status check failed:', err);
      return { isAuthenticated: false, tokenIndex: accountManager.getCurrentIndex() };
    }
  }

  /**
   * List available models.
   */
  async listModels(cwd: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const client = await this.getClient(cwd);
      const models = await client.listModels();
      return models.map((m: { id: string; name: string }) => ({ id: m.id, name: m.name }));
    } catch (err) {
      console.error('[sdk-client-manager] Failed to list models:', err);
      return [];
    }
  }

  /**
   * Shutdown all clients gracefully.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.pendingClients.clear();

    if (this.staleSessionTimer) {
      clearInterval(this.staleSessionTimer);
      this.staleSessionTimer = null;
    }

    const errors: Error[] = [];

    // Clear our tracking first (prevents sweeper interference)
    for (const entry of this.clients.values()) {
      entry.sessions.clear();
    }

    // Let SDK stop() handle cleanup with its own retry+backoff, with forceStop fallback
    for (const [key, entry] of this.clients) {
      try {
        const clientErrors = await withTimeout(entry.client.stop(), SHUTDOWN_STOP_TIMEOUT_MS, `stop client ${key}`);
        errors.push(...clientErrors);
      } catch (err) {
        console.error(`[sdk-client-manager] Shutdown: stop timed out for ${key}, forcing`);
        try { await entry.client.forceStop(); } catch (e) {
          errors.push(new Error(`Failed to force-stop client ${key}: ${e}`));
        }
      }
    }

    this.clients.clear();
    if (errors.length > 0) {
      console.error('[sdk-client-manager] Shutdown errors:', errors);
    }
  }

  /**
   * Get statistics about active clients, sessions, and account rotation.
   */
  getStats(): { 
    pools: number; 
    clients: number; 
    sessions: number;
    accounts: {
      total: number;
      current: number;
      rotations: number;
      available: number;
    };
  } {
    let sessions = 0;

    for (const entry of this.clients.values()) {
      sessions += entry.sessions.size;
    }

    const accountStats = accountManager.getStats();

    return {
      pools: 1,
      clients: this.clients.size,
      sessions,
      accounts: {
        total: accountStats.totalTokens,
        current: accountStats.currentIndex + 1,
        rotations: accountStats.rotationCount,
        available: accountStats.availableTokens,
      },
    };
  }
}

export const sdkClientManager = new SDKClientManager();
