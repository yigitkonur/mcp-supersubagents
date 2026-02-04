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

    // Method 3: Single token fallback (GITHUB_TOKEN or GH_TOKEN)
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
    // Limit to MAX_ACCOUNTS
    const limitedTokens = tokens.slice(0, MAX_ACCOUNTS);
    
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
    return this.tokens[this.currentIndex]?.token;
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
    this.currentIndex = 0;
    this.rotationCount = 0;
    this.lastRotationTime = undefined;
    
    // Clear failure states
    for (const state of this.tokens) {
      state.failedAt = undefined;
      state.failureReason = undefined;
      state.failureCount = 0;
    }

    console.error(`[account-manager] Reset to first account (${this.tokens.length} total)`);
  }

  /**
   * Rotate to the next available token.
   * Called when current token encounters rate limit or error.
   * 
   * @param reason - Reason for rotation (e.g., 'rate_limit', 'server_error')
   * @returns Result with new token or exhausted status
   */
  rotateToNext(reason: string = 'unknown'): AccountRotationResult {
    if (this.tokens.length === 0) {
      return { success: false, error: 'No tokens configured' };
    }

    if (this.tokens.length === 1) {
      // Single token mode - can't rotate
      return { success: false, error: 'Single token mode - cannot rotate' };
    }

    // Mark current token as failed
    const currentState = this.tokens[this.currentIndex];
    if (currentState) {
      currentState.failedAt = Date.now();
      currentState.failureReason = reason;
      currentState.failureCount++;
      console.error(`[account-manager] Token #${this.currentIndex + 1} failed: ${reason} (count: ${currentState.failureCount})`);
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
        const cooldownRemaining = FAILED_TOKEN_COOLDOWN_MS - (now - nextState.failedAt);
        if (cooldownRemaining > 0) {
          // Still in cooldown, try next
          continue;
        }
        // Cooldown expired, clear failure state
        nextState.failedAt = undefined;
        nextState.failureReason = undefined;
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
}

export const accountManager = new AccountManager();
