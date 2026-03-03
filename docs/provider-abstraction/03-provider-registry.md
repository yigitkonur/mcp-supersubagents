# Provider Registry

Defined in `src/providers/registry.ts`. Exported as the singleton `providerRegistry`.

```typescript
class ProviderRegistry {
  private providers = new Map<string, ProviderAdapter>();
  private chain: ChainEntry[] = [];
  // ...
}

export const providerRegistry = new ProviderRegistry();
```

## Registration

Providers are registered at startup in `src/index.ts`, before the MCP server begins accepting connections:

```typescript
providerRegistry.register(new CopilotProviderAdapter());
providerRegistry.register(new CodexProviderAdapter());
providerRegistry.register(new ClaudeProviderAdapter());
```

`register()` stores the adapter in a `Map<string, ProviderAdapter>` keyed by `provider.id`. If a provider with the same ID is registered twice, the second replaces the first.

```typescript
register(provider: ProviderAdapter): void {
  this.providers.set(provider.id, provider);
  console.error(`[provider-registry] Registered provider: ${provider.id} (${provider.displayName})`);
}
```

## Chain Configuration

After registration, the chain is configured from the `PROVIDER_CHAIN` environment variable:

```typescript
const chainStr = process.env.PROVIDER_CHAIN || 'copilot,codex,!claude-cli';
providerRegistry.configureChain(parseChainString(chainStr));
```

### `PROVIDER_CHAIN` Format

Comma-separated provider IDs. The `!` prefix marks a provider as fallback-only.

```
copilot,codex,!claude-cli
```

Parses to:

```typescript
[
  { id: 'copilot', fallbackOnly: false },
  { id: 'codex',   fallbackOnly: false },
  { id: 'claude-cli', fallbackOnly: true },
]
```

### `parseChainString(chainStr: string): ChainEntry[]`

```typescript
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
```

### `configureChain(entries: ChainEntry[]): void`

Validates that all referenced IDs correspond to registered providers. Unregistered IDs are logged and skipped:

```typescript
configureChain(entries: ChainEntry[]): void {
  const valid = entries.filter(entry => {
    if (!this.providers.has(entry.id)) {
      console.error(`[provider-registry] Warning: chain references unregistered provider '${entry.id}', skipping`);
      return false;
    }
    return true;
  });
  this.chain = valid;
  const display = valid.map(e => e.fallbackOnly ? `!${e.id}` : e.id).join(' -> ');
  console.error(`[provider-registry] Chain configured: ${display}`);
}
```

## `selectProvider(): ProviderSelection | null`

Called by `shared-spawn.ts` for every new task. Returns the first available non-fallback-only provider in the chain.

```typescript
export interface ProviderSelection {
  provider: ProviderAdapter;
  chainIndex: number;  // 0-based position in chain
}
```

### Algorithm

1. Walk the chain in order
2. Skip entries where `fallbackOnly === true`
3. For each non-fallback entry, call `provider.checkAvailability()`
4. Return the first one that reports `available: true`
5. If no primary provider is available, walk the chain again looking at fallback-only entries
6. If still nothing, return `null`

```typescript
selectProvider(): ProviderSelection | null {
  // Pass 1: primary providers (fallbackOnly === false)
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

  // Pass 2: fallback-only providers as last resort
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
```

The two-pass design means fallback-only providers are a true last resort. Even if `!claude-cli` is the only provider that could handle the task, it will only be selected after all primary providers have been checked and found unavailable.

## `selectFallback(failedProviderId: string): ProviderSelection | null`

Called by `triggerFallback()` in `fallback-handler.ts` when a provider fails mid-task. Returns the next available provider in the chain **after** the failed one.

### Algorithm

1. Find the failed provider's position in the chain
2. Start from `failedIndex + 1`
3. Walk forward, checking availability of every remaining provider (both primary and fallback-only)
4. Return the first available, or `null`

```typescript
selectFallback(failedProviderId: string): ProviderSelection | null {
  const failedIndex = this.chain.findIndex(e => e.id === failedProviderId);
  const startIndex = failedIndex >= 0 ? failedIndex + 1 : 0;

  for (let i = startIndex; i < this.chain.length; i++) {
    const entry = this.chain[i];
    const provider = this.providers.get(entry.id);
    if (!provider) continue;

    const availability = provider.checkAvailability();
    if (availability.available) {
      console.error(
        `[provider-registry] Fallback: '${failedProviderId}' -> '${entry.id}'`
      );
      return { provider, chainIndex: i };
    }
  }

  console.error(`[provider-registry] No fallback available after '${failedProviderId}'`);
  return null;
}
```

Unlike `selectProvider()`, `selectFallback()` does **not** skip `fallbackOnly` entries. During fallback, every remaining provider in the chain is a candidate.

If the failed provider is not found in the chain (returns index `-1`), the search starts from the beginning of the chain (index `0`).

## `isFallbackEnabled(): boolean`

Returns `true` if the chain has more than one entry. Used by `fallback-handler.ts` to short-circuit fallback logic when there is only a single provider configured.

```typescript
isFallbackEnabled(): boolean {
  return this.chain.length > 1;
}
```

## Utility Methods

### `getProvider(id: string | undefined): ProviderAdapter | undefined`

Direct lookup by ID. Returns `undefined` for `undefined` input or missing providers.

### `getCapabilities(id: string | undefined): ProviderCapabilities | undefined`

Convenience method combining `getProvider()` + `getCapabilities()`. Used by tool handlers to check feature support.

### `hasProvider(id: string): boolean`

Check if a provider ID is registered.

### `getProviderIds(): string[]`

Returns all registered provider IDs as an array.

### `getChain(): ReadonlyArray<ChainEntry>`

Returns the current chain configuration (read-only view).

### `getAllStats(): Record<string, Record<string, unknown>>`

Aggregates `getStats()` from all registered providers for the `system:///status` resource.

## `shutdownAll(): Promise<void>`

Called during server exit. Iterates all registered providers and calls `shutdown()` on each, using `Promise.allSettled` so one failure does not block others:

```typescript
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
```
