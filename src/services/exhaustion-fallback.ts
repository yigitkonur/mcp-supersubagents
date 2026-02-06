/**
 * Exhaustion Fallback Policy
 *
 * Encapsulates the decision logic for when to fallback to Claude Agent SDK.
 * ONLY activates when allExhausted=true (all Copilot accounts are in cooldown).
 *
 * Does NOT trigger for:
 * - Auth errors (401/403)
 * - Timeouts
 * - Single-account failures
 * - Network errors
 */

const FALLBACK_ENABLED = process.env.DISABLE_CLAUDE_CODE_FALLBACK !== 'true';

export interface RotationResult {
  success: boolean;
  allExhausted?: boolean;
  error?: string;
}

/**
 * Determine if we should fallback to Claude Agent SDK.
 * Only returns true when ALL Copilot accounts are exhausted.
 */
export function shouldFallbackToClaudeCode(rotationResult: RotationResult): boolean {
  if (!FALLBACK_ENABLED) {
    return false;
  }
  return rotationResult.allExhausted === true;
}

/**
 * Check if fallback is enabled via environment variable.
 */
export function isFallbackEnabled(): boolean {
  return FALLBACK_ENABLED;
}
