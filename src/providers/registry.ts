/**
 * Provider Registry — Singleton managing all registered AI providers.
 *
 * Responsibilities:
 * - Provider registration at startup
 * - Chain configuration (primary → fallback order)
 * - Provider selection (first available in chain)
 * - Fallback selection (next provider after a failure)
 * - Graceful shutdown of all providers
 */

import type {
  ProviderAdapter,
  ProviderCapabilities,
  AvailabilityResult,
  ChainEntry,
} from './types.js';

export interface ProviderSelection {
  provider: ProviderAdapter;
  /** Position in the chain (0-based) */
  chainIndex: number;
}

/**
 * Parse the PROVIDER_CHAIN env var string into ChainEntry[].
 *
 * Format: comma-separated provider IDs. Prefix `!` = fallback-only.
 * Example: "copilot,codex,!claude-cli"
 */
export function parseChainString(chainStr: string): ChainEntry[] {
  return chainStr
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      if (entry.startsWith('!')) {
        return { id: entry.slice(1), fallbackOnly: true };
      }
      return { id: entry, fallbackOnly: false };
    });
}

class ProviderRegistry {
  private providers = new Map<string, ProviderAdapter>();
  private chain: ChainEntry[] = [];

  /**
   * Register a provider adapter. Called at startup.
   * Replaces any existing provider with the same id.
   */
  register(provider: ProviderAdapter): void {
    this.providers.set(provider.id, provider);
    console.error(`[provider-registry] Registered provider: ${provider.id} (${provider.displayName})`);
  }

  /**
   * Configure the provider chain (selection + fallback order).
   * Call after all providers are registered.
   */
  configureChain(entries: ChainEntry[]): void {
    // Validate that all chain entries reference registered providers
    const valid = entries.filter(entry => {
      if (!this.providers.has(entry.id)) {
        console.error(`[provider-registry] Warning: chain references unregistered provider '${entry.id}', skipping`);
        return false;
      }
      return true;
    });
    this.chain = valid;
    const display = valid.map(e => e.fallbackOnly ? `!${e.id}` : e.id).join(' → ');
    console.error(`[provider-registry] Chain configured: ${display}`);
  }

  /**
   * Select the primary provider for a new task.
   *
   * If preferredProviderId is given, try that provider first (even if fallbackOnly)
   * before walking the rest of the chain. This enables model-aware routing:
   * codex models prefer the codex provider.
   */
  selectProvider(preferredProviderId?: string): ProviderSelection | null {
    // Try preferred provider first (e.g., codex for GPT models)
    if (preferredProviderId) {
      const idx = this.chain.findIndex(e => e.id === preferredProviderId);
      if (idx >= 0) {
        const provider = this.providers.get(preferredProviderId);
        if (provider) {
          const availability = provider.checkAvailability();
          if (availability.available) {
            return { provider, chainIndex: idx };
          }
          console.error(
            `[provider-registry] Preferred provider '${preferredProviderId}' unavailable: ${availability.reason ?? 'unknown'}`
          );
        }
      }
    }

    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i];
      if (entry.fallbackOnly) continue;

      const provider = this.providers.get(entry.id);
      if (!provider) continue;

      const availability = provider.checkAvailability();
      if (availability.available) {
        return { provider, chainIndex: i };
      }

      console.error(
        `[provider-registry] Provider '${entry.id}' unavailable: ${availability.reason ?? 'unknown'}`
      );
    }

    // No primary provider available — try fallback-only providers as last resort
    for (let i = 0; i < this.chain.length; i++) {
      const entry = this.chain[i];
      if (!entry.fallbackOnly) continue;

      const provider = this.providers.get(entry.id);
      if (!provider) continue;

      const availability = provider.checkAvailability();
      if (availability.available) {
        console.error(`[provider-registry] No primary provider available, using fallback '${entry.id}'`);
        return { provider, chainIndex: i };
      }
    }

    console.error('[provider-registry] No providers available');
    return null;
  }

  /**
   * Select the next fallback provider after a failure.
   * Returns the next available provider in the chain AFTER the failed one.
   */
  selectFallback(failedProviderId: string): ProviderSelection | null {
    // Find the failed provider's position in the chain
    const failedIndex = this.chain.findIndex(e => e.id === failedProviderId);
    const startIndex = failedIndex >= 0 ? failedIndex + 1 : 0;

    for (let i = startIndex; i < this.chain.length; i++) {
      const entry = this.chain[i];
      const provider = this.providers.get(entry.id);
      if (!provider) continue;

      const availability = provider.checkAvailability();
      if (availability.available) {
        console.error(
          `[provider-registry] Fallback: '${failedProviderId}' → '${entry.id}'`
        );
        return { provider, chainIndex: i };
      }
    }

    console.error(`[provider-registry] No fallback available after '${failedProviderId}'`);
    return null;
  }

  /** Get a provider by ID */
  getProvider(id: string | undefined): ProviderAdapter | undefined {
    if (!id) return undefined;
    return this.providers.get(id);
  }

  /** Get capabilities for a provider by ID */
  getCapabilities(id: string | undefined): ProviderCapabilities | undefined {
    const provider = this.getProvider(id);
    return provider?.getCapabilities();
  }

  /** Check if a specific provider is registered */
  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  /** Get all registered provider IDs */
  getProviderIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Get the current chain configuration */
  getChain(): ReadonlyArray<ChainEntry> {
    return this.chain;
  }

  /**
   * Check if fallback is enabled (at least one fallback provider in chain).
   * Replaces the old isFallbackEnabled() from exhaustion-fallback.ts.
   */
  isFallbackEnabled(): boolean {
    return this.chain.length > 1;
  }

  /**
   * Graceful shutdown of all providers.
   * Called during server exit.
   */
  async shutdownAll(): Promise<void> {
    const providers = Array.from(this.providers.values());
    console.error(`[provider-registry] Shutting down ${providers.length} providers`);

    await Promise.allSettled(
      providers.map(async (provider) => {
        try {
          await provider.shutdown();
          console.error(`[provider-registry] Provider '${provider.id}' shut down`);
        } catch (err) {
          console.error(`[provider-registry] Error shutting down '${provider.id}':`, err);
        }
      })
    );
  }

  /** Aggregate stats from all providers for system:///status */
  getAllStats(): Record<string, Record<string, unknown>> {
    const stats: Record<string, Record<string, unknown>> = {};
    for (const [id, provider] of this.providers) {
      stats[id] = provider.getStats();
    }
    return stats;
  }
}

// Export singleton
export const providerRegistry = new ProviderRegistry();
