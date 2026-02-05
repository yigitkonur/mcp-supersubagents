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

const COPILOT_PATH = process.env.COPILOT_PATH || '/opt/homebrew/bin/copilot';

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

class SDKClientManager {
  private clients: Map<string, ClientEntry> = new Map();
  private isShuttingDown = false;

  /**
   * Initialize the client manager (call on MCP connect).
   * Initializes the account manager and resets to first token.
   */
  initialize(): void {
    accountManager.initialize();
    console.error(`[sdk-client-manager] Initialized with ${accountManager.getTokenCount()} account(s)`);
  }

  /**
   * Reset the client manager (call on MCP reconnect).
   * Clears all clients and resets account rotation to first token.
   */
  async reset(): Promise<void> {
    // Stop all existing clients
    for (const [key, entry] of this.clients) {
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

    let entry = this.clients.get(clientKey);
    if (entry) {
      entry.lastUsedAt = new Date();
      return entry.client;
    }

    // Create new client with current token
    const client = await this.createClient(cwd, currentToken);
    entry = {
      client,
      cwd,
      tokenIndex,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      sessions: new Map(),
    };
    this.clients.set(clientKey, entry);

    console.error(`[sdk-client-manager] Created client for cwd=${cwd} with token #${tokenIndex + 1}/${accountManager.getTokenCount()}`);
    return client;
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
      autoRestart: true,
    };

    if (githubToken) {
      options.githubToken = githubToken;
      options.useLoggedInUser = false;
    }

    const client = new CopilotClient(options);
    await client.start();
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
    
    // Build resume config with user input handler and hooks if taskId provided
    const resumeConfig: Partial<SessionConfig> = { ...config };
    
    if (taskId) {
      resumeConfig.onUserInputRequest = createUserInputHandler(taskId);
      // Wire SDK session hooks for lifecycle events, error handling, and tool telemetry
      resumeConfig.hooks = createSessionHooks(taskId);
    }
    
    const session = await client.resumeSession(sessionId, resumeConfig);

    // Track the resumed session in the client entry
    const tokenIndex = accountManager.getCurrentIndex();
    const clientKey = `${cwd}:${tokenIndex}`;
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
        try {
          await session.destroy();
        } catch (err) {
          console.error(`[sdk-client-manager] Failed to destroy session ${sessionId}:`, err);
        }
        entry.sessions.delete(sessionId);
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
      return { success: true, client };
    } catch (err) {
      return { 
        success: false, 
        error: `Failed to create client with new token: ${err}` 
      };
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

    const errors: Error[] = [];

    for (const [key, entry] of this.clients) {
      // Destroy all sessions first
      for (const [sessionId, session] of entry.sessions) {
        try {
          await session.destroy();
        } catch (err) {
          errors.push(new Error(`Failed to destroy session ${sessionId}: ${err}`));
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
