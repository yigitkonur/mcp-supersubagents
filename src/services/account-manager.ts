/**
 * Multi-Account Manager - In-memory round-robin rotation for GitHub PAT tokens.
 * 
 * Supports up to 100 GitHub PAT tokens for failover on rate limits and errors.
 * Key features:
 * - Round-robin rotation through configured tokens
 * - Automatic failover on rate limit (429) or server errors (5xx)
 * - Reset to first token on MCP reconnect
 * - Track failed tokens to skip them temporarily
 */

const MAX_ACCOUNTS = 100;
const FAILED_TOKEN_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown for failed tokens
const STALE_FAILURE_THRESHOLD_MS = 300_000; // 5 minutes - auto-heal after this

interface TokenState {
  token: string;
  index: number;
  failedAt?: number;
  failureReason?: string;
  failureCount: number;
}

interface AccountRotationResult {
  success: boolean;
  token?: string;
  tokenIndex?: number;
  allExhausted?: boolean;
  error?: string;
}

class AccountManager {
  private tokens: TokenState[] = [];
  private currentIndex = 0;
  private rotationCount = 0;
  private lastRotationTime?: Date;
  private initialized = false;

  /**
   * Initialize the account manager with GitHub PAT tokens.
   * Tokens can be provided via:
   * - GITHUB_PAT_TOKENS env var (comma-separated)
   * - GITHUB_PAT_TOKEN_1, GITHUB_PAT_TOKEN_2, ... env vars
   * - Direct configuration via setTokens()
   */
  initialize(): void {
    if (this.initialized) return;

    const tokens: string[] = [];

    // Method 1: Comma-separated tokens in GITHUB_PAT_TOKENS
    const commaTokens = process.env.GITHUB_PAT_TOKENS;
    if (commaTokens) {
      const parsed = commaTokens.split(',').map(t => t.trim()).filter(t => t.length > 0);
      tokens.push(...parsed);
    }

    // Method 2: Numbered env vars GITHUB_PAT_TOKEN_1, GITHUB_PAT_TOKEN_2, etc.
    for (let i = 1; i <= MAX_ACCOUNTS; i++) {
      const token = process.env[`GITHUB_PAT_TOKEN_${i}`];
      if (token && token.trim()) {
        // Avoid duplicates
        if (!tokens.includes(token.trim())) {
          tokens.push(token.trim());
        }
      }
    }

    // Method 3: GH_PAT_TOKEN (supports comma-separated for multi-account)
    if (tokens.length === 0 && process.env.GH_PAT_TOKEN) {
      const ghPatTokens = process.env.GH_PAT_TOKEN.split(',').map(t => t.trim()).filter(t => t.length > 0);
      tokens.push(...ghPatTokens);
    }

    // Method 4: Single token fallback (GITHUB_TOKEN or GH_TOKEN)
    if (tokens.length === 0) {
      const singleToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (singleToken && singleToken.trim()) {
        tokens.push(singleToken.trim());
      }
    }

    this.setTokens(tokens);
    this.initialized = true;

    console.error(`[account-manager] Initialized with ${this.tokens.length} account(s)`);
  }

  /**
   * Set tokens directly (useful for testing or programmatic configuration).
   */
  setTokens(tokens: string[]): void {
    // Deduplicate tokens before applying limit
    const uniqueTokens = [...new Set(tokens)];
    if (uniqueTokens.length < tokens.length) {
      console.error(`[account-manager] Removed ${tokens.length - uniqueTokens.length} duplicate token(s)`);
    }
    const limitedTokens = uniqueTokens.slice(0, MAX_ACCOUNTS);
    if (uniqueTokens.length > MAX_ACCOUNTS) {
      console.error(`[account-manager] WARNING: ${uniqueTokens.length} tokens configured but max is ${MAX_ACCOUNTS}. ${uniqueTokens.length - MAX_ACCOUNTS} token(s) will be ignored.`);
    }
    
    this.tokens = limitedTokens.map((token, index) => ({
      token,
      index,
      failureCount: 0,
    }));
    
    this.currentIndex = 0;
    this.rotationCount = 0;
    this.lastRotationTime = undefined;
  }

  /**
   * Get the current active token.
   * Returns undefined if no tokens configured.
   */
  getCurrentToken(): string | undefined {
    if (this.tokens.length === 0) {
      return undefined;
    }
    const current = this.tokens[this.currentIndex];
    if (!current) return undefined;
    // If current token is in active cooldown, scan for a non-cooldown token
    if (current.failedAt) {
      const age = Date.now() - current.failedAt;
      if (age < FAILED_TOKEN_COOLDOWN_MS) {
        // Current token in cooldown — try to find any available token
        const now = Date.now();
        for (let i = 0; i < this.tokens.length; i++) {
          const state = this.tokens[i];
          if (!state.failedAt || (now - state.failedAt) >= FAILED_TOKEN_COOLDOWN_MS) {
            this.currentIndex = i;
            return state.token;
          }
        }
        return undefined; // All tokens in cooldown
      }
    }
    return current.token;
  }

  /**
   * Get the current token index.
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Get total number of configured tokens.
   */
  getTokenCount(): number {
    return this.tokens.length;
  }

  /**
   * Check if multi-account mode is enabled (more than 1 token).
   */
  isMultiAccountEnabled(): boolean {
    return this.tokens.length > 1;
  }

  /**
   * Reset to the first token (called on MCP reconnect).
   */
  reset(): void {
    this.rotationCount = 0;
    this.lastRotationTime = undefined;
    
    // Only clear expired cooldowns — preserve active ones to prevent immediate re-rate-limit
    const now = Date.now();
    let firstAvailable = -1;
    for (let i = 0; i < this.tokens.length; i++) {
      const state = this.tokens[i];
      if (state.failedAt && (now - state.failedAt) < FAILED_TOKEN_COOLDOWN_MS) {
        // Active cooldown — keep it
        continue;
      }
      // Cooldown expired or no failure — clear state
      state.failedAt = undefined;
      state.failureReason = undefined;
      state.failureCount = 0;
      if (firstAvailable < 0) firstAvailable = i;
    }
    this.currentIndex = firstAvailable >= 0 ? firstAvailable : 0;

    console.error(`[account-manager] Reset (${this.tokens.length} total, index=${this.currentIndex})`);
  }

  /**
   * Rotate to the next available token.
   * Called when current token encounters rate limit or error.
   * 
   * @param reason - Reason for rotation (e.g., 'rate_limit', 'server_error')
   * @param fromTokenIndex - Index of the token that actually failed (avoids thundering-herd misattribution)
   * @returns Result with new token or exhausted status
   */
  rotateToNext(reason: string = 'unknown', fromTokenIndex?: number): AccountRotationResult {
    if (this.tokens.length === 0) {
      return { success: false, error: 'No tokens configured' };
    }

    if (this.tokens.length === 1) {
      // Single token mode - mark current token as failed
      const singleState = this.tokens[0];
      if (singleState) {
        singleState.failedAt = Date.now();
        singleState.failureReason = reason;
        singleState.failureCount++;
      }
      return { success: false, allExhausted: true, error: 'Single token mode - cannot rotate, token exhausted' };
    }

    // Mark the token that actually failed (not necessarily currentIndex)
    const failIndex = fromTokenIndex ?? this.currentIndex;
    const failedState = this.tokens[failIndex];
    if (failedState) {
      failedState.failedAt = Date.now();
      failedState.failureReason = reason;
      failedState.failureCount++;
      console.error(`[account-manager] Token #${failIndex + 1} failed: ${reason} (count: ${failedState.failureCount})`);
    }

    // Find next available token
    const startIndex = this.currentIndex;
    let attempts = 0;
    const now = Date.now();

    while (attempts < this.tokens.length) {
      // Move to next index (round-robin)
      this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
      attempts++;

      const nextState = this.tokens[this.currentIndex];
      
      // Check if this token is in cooldown
      if (nextState.failedAt) {
        const failedAge = now - nextState.failedAt;
        // Auto-reset stale failures older than 5 minutes
        if (failedAge > STALE_FAILURE_THRESHOLD_MS) {
          nextState.failedAt = undefined;
          nextState.failureReason = undefined;
          nextState.failureCount = 0;
        } else {
          const cooldownRemaining = FAILED_TOKEN_COOLDOWN_MS - failedAge;
          if (cooldownRemaining > 0) {
            // Still in cooldown, try next
            continue;
          }
          // Cooldown expired, clear failure state
          nextState.failedAt = undefined;
          nextState.failureReason = undefined;
          nextState.failureCount = 0;
        }
      }

      // Found an available token
      this.rotationCount++;
      this.lastRotationTime = new Date();
      
      console.error(`[account-manager] Rotated to token #${this.currentIndex + 1}/${this.tokens.length} (rotation #${this.rotationCount})`);
      
      return {
        success: true,
        token: nextState.token,
        tokenIndex: this.currentIndex,
      };
    }

    // All tokens are in cooldown - all exhausted
    console.error(`[account-manager] All ${this.tokens.length} tokens exhausted or in cooldown`);
    
    // Reset to first token anyway (best effort)
    this.currentIndex = 0;
    
    return {
      success: false,
      allExhausted: true,
      error: `All ${this.tokens.length} tokens are rate limited or failed`,
    };
  }

  /**
   * Check if rotation should happen based on error type.
   * Returns true for rate limits (429) and server errors (5xx).
   */
  shouldRotate(statusCode?: number, errorMessage?: string): boolean {
    // No rotation if single token
    if (this.tokens.length <= 1) {
      return false;
    }

    // Rate limit
    if (statusCode === 429) {
      return true;
    }

    // Server errors (5xx)
    if (statusCode && statusCode >= 500 && statusCode < 600) {
      return true;
    }

    // Check error message for rate limit patterns
    if (errorMessage) {
      const lowerMsg = errorMessage.toLowerCase();
      if (lowerMsg.includes('rate limit') ||
          lowerMsg.includes('too many requests') ||
          lowerMsg.includes('quota exceeded')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get statistics about token usage.
   */
  getStats(): {
    totalTokens: number;
    currentIndex: number;
    rotationCount: number;
    lastRotation?: string;
    failedTokens: number;
    availableTokens: number;
  } {
    const now = Date.now();
    const failedCount = this.tokens.filter(t => 
      t.failedAt && (now - t.failedAt) < FAILED_TOKEN_COOLDOWN_MS
    ).length;

    return {
      totalTokens: this.tokens.length,
      currentIndex: this.currentIndex,
      rotationCount: this.rotationCount,
      lastRotation: this.lastRotationTime?.toISOString(),
      failedTokens: failedCount,
      availableTokens: this.tokens.length - failedCount,
    };
  }

  /**
   * Get a masked version of the current token for logging.
   */
  getMaskedCurrentToken(): string {
    const token = this.getCurrentToken();
    if (!token) return '(none)';
    if (token.length <= 8) return '****';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }

  /**
   * Mark a token as successfully used, resetting its failure count.
   * Call after a session completes successfully.
   */
  markSuccess(tokenIndex: number): void {
    const state = this.tokens[tokenIndex];
    if (state) {
      state.failedAt = undefined;
      state.failureReason = undefined;
      state.failureCount = 0;
    }
  }

  /**
   * Reset stale cooldowns for tokens whose failedAt is older than maxAgeMs.
   * Auto-heals tokens that were temporarily rate-limited but have since recovered.
   */
  resetStaleCooldowns(maxAgeMs: number = 300_000): void {
    const now = Date.now();
    for (const state of this.tokens) {
      if (state.failedAt && (now - state.failedAt) > maxAgeMs) {
        state.failedAt = undefined;
        state.failureReason = undefined;
        state.failureCount = 0;
      }
    }
  }

  /**
   * Export cooldown state for persistence (does NOT include tokens themselves).
   * Only exports tokens with active cooldowns to minimize disk writes.
   */
  exportCooldownState(): Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }> {
    const now = Date.now();
    return this.tokens
      .filter(t => t.failedAt && (now - t.failedAt) < STALE_FAILURE_THRESHOLD_MS)
      .map(t => ({
        index: t.index,
        failedAt: t.failedAt!,
        failureReason: t.failureReason,
        failureCount: t.failureCount,
      }));
  }

  /**
   * Import cooldown state from persistence (e.g., after server restart).
   * Only applies cooldowns that are still within the cooldown window.
   */
  importCooldownState(cooldowns: Array<{ index: number; failedAt: number; failureReason?: string; failureCount: number }>): void {
    const now = Date.now();
    let applied = 0;
    for (const cd of cooldowns) {
      if (cd.index < 0 || cd.index >= this.tokens.length) continue;
      // Only restore cooldowns that haven't expired yet
      if (now - cd.failedAt >= STALE_FAILURE_THRESHOLD_MS) continue;
      const state = this.tokens[cd.index];
      if (state) {
        state.failedAt = cd.failedAt;
        state.failureReason = cd.failureReason;
        state.failureCount = cd.failureCount;
        applied++;
      }
    }
    if (applied > 0) {
      console.error(`[account-manager] Restored ${applied} cooldown(s) from persistence`);
      // Advance currentIndex past any tokens in active cooldown
      const available = this.tokens.findIndex(t => !t.failedAt || (now - t.failedAt) >= FAILED_TOKEN_COOLDOWN_MS);
      if (available >= 0) {
        this.currentIndex = available;
      }
    }
  }

  /**
   * Clear all sensitive token data from memory.
   * Call during server shutdown to prevent token leaks.
   */
  cleanup(): void {
    this.tokens = [];
    this.currentIndex = 0;
    this.rotationCount = 0;
    this.initialized = false;
  }
}

export const accountManager = new AccountManager();
export const resetStaleCooldowns = (maxAgeMs?: number) => accountManager.resetStaleCooldowns(maxAgeMs);
export const cleanup = () => accountManager.cleanup();
