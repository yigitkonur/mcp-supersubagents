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
import { accountManager } from './account-manager.js';
import { questionRegistry } from './question-registry.js';
import { createSessionHooks } from './session-hooks.js';
import { taskManager } from './task-manager.js';
import { TERMINAL_STATUSES } from '../types.js';

const COPILOT_PATH = process.env.COPILOT_PATH || '/opt/homebrew/bin/copilot';

// Timeouts for SDK operations that can hang
const DESTROY_SESSION_TIMEOUT_MS = 10_000;
const CLIENT_START_TIMEOUT_MS = 30_000;
const SHUTDOWN_DESTROY_TIMEOUT_MS = 5_000;

/**
 * Race a promise against a timeout. Rejects with a descriptive error if the timeout fires first.
 * Clears the timeout when the promise resolves to prevent timer leaks.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

interface ClientEntry {
  client: CopilotClient;
  cwd: string;
  tokenIndex: number;
  createdAt: Date;
  lastUsedAt: Date;
  sessions: Map<string, CopilotSession>;
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

// Interval for periodic stale session cleanup (every 60 seconds)
const STALE_SESSION_CLEANUP_INTERVAL_MS = 60_000;

class SDKClientManager {
  private clients: Map<string, ClientEntry> = new Map();
  private pendingClients: Map<string, Promise<CopilotClient>> = new Map(); // RC-3: Dedup concurrent getClient calls
  private isShuttingDown = false;
  private staleSessionTimer: NodeJS.Timeout | null = null;

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
   * Start periodic sweeper that detects and destroys orphaned sessions.
   * A session is orphaned if it's tracked in a client entry but its corresponding
   * task is in a terminal state or no longer exists.
   */
  private startStaleSessionSweeper(): void {
    if (this.staleSessionTimer) {
      clearInterval(this.staleSessionTimer);
    }
    this.staleSessionTimer = setInterval(() => {
      this.sweepStaleSessions();
    }, STALE_SESSION_CLEANUP_INTERVAL_MS);
  }

  /**
   * Sweep and destroy orphaned sessions across all client entries.
   * This is the safety net that catches sessions missed by normal lifecycle cleanup.
   */
  private sweepStaleSessions(): void {
    if (this.isShuttingDown) return;

    let destroyed = 0;
    for (const [clientKey, entry] of this.clients) {
      for (const [sessionId, session] of entry.sessions) {
        // Check if any active (non-terminal) task references this session
        const task = taskManager.getTask(sessionId); // sessionId === taskId by convention
        const isOrphaned = !task || TERMINAL_STATUSES.has(task.status);

        if (isOrphaned) {
          // Remove from tracking first, then fire-and-forget destroy with timeout
          entry.sessions.delete(sessionId);
          withTimeout(session.destroy(), DESTROY_SESSION_TIMEOUT_MS, `sweeper:destroy(${sessionId})`).catch((err) => {
            console.error(`[sdk-client-manager] Sweeper: failed to destroy session ${sessionId}:`, err);
          });
          destroyed++;
        }
      }
    }

    if (destroyed > 0) {
      console.error(`[sdk-client-manager] Sweeper: destroyed ${destroyed} orphaned session(s)`);
      // Now that sessions are cleared, try to clean up stale clients too
      this.cleanupStaleClients();
    }
  }

  /**
   * Reset the client manager (call on MCP reconnect).
   * Clears all clients and resets account rotation to first token.
   */
  async reset(): Promise<void> {
    // Invalidate any in-flight client creations before stopping existing clients
    this.pendingClients.clear();

    // Destroy all sessions first, then stop clients
    for (const [key, entry] of this.clients) {
      // Destroy sessions in parallel to release PTY FDs (with timeout so hung sessions don't block reset)
      await Promise.allSettled(
        [...entry.sessions.entries()].map(([sessionId, session]) =>
          withTimeout(session.destroy(), DESTROY_SESSION_TIMEOUT_MS, `reset:destroy(${sessionId})`)
            .catch(err => console.error(`[sdk-client-manager] Error destroying session ${sessionId} during reset:`, err))
        )
      );
      entry.sessions.clear();

      // Then stop the client
      try {
        await entry.client.stop();
      } catch (err) {
        console.error(`[sdk-client-manager] Error stopping client ${key}:`, err);
      }
    }
    this.clients.clear();

    // Reset account manager to first token
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
      autoRestart: false, // RC-4 fix: Disable auto-restart to prevent unbounded CLI respawning and PTY accumulation
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
        // Remove from tracking first to prevent double-destroy from sweeper
        entry.sessions.delete(sessionId);
        try {
          await withTimeout(session.destroy(), DESTROY_SESSION_TIMEOUT_MS, `destroySession(${sessionId})`);
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

    // Stop the stale session sweeper
    if (this.staleSessionTimer) {
      clearInterval(this.staleSessionTimer);
      this.staleSessionTimer = null;
    }

    const errors: Error[] = [];

    for (const [key, entry] of this.clients) {
      // Destroy all sessions in parallel (with timeout so one hung session doesn't block shutdown)
      const results = await Promise.allSettled(
        [...entry.sessions.entries()].map(([sessionId, session]) =>
          withTimeout(session.destroy(), SHUTDOWN_DESTROY_TIMEOUT_MS, `shutdown:destroy(${sessionId})`)
        )
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          errors.push(r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
        }
      }
      entry.sessions.clear();

      // Stop the client
      try {
        const clientErrors = await entry.client.stop();
        errors.push(...clientErrors);
      } catch (err) {
        errors.push(new Error(`Failed to stop client for ${key}: ${err}`));
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
