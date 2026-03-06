#!/usr/bin/env node

/**
 * Model-Provider Compatibility Tests
 *
 * Verifies that:
 * 1. canRunModel() correctly gates model-provider pairings
 * 2. selectProvider() respects model compatibility in chain walks
 * 3. selectFallback() skips incompatible providers
 * 4. Edge cases: unknown models, all-disabled, single-provider chains
 */

import process from 'node:process';

// Import from built JS — run `pnpm build` first
import { canRunModel, getPreferredProvider, resolveModelForProvider, resolveModel, MODEL_ALIASES, getAvailableModelIds, getModelOverride, MODEL_IDS } from '../build/models.js';
import { parseChainString } from '../build/providers/registry.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function section(name) {
  process.stdout.write(`\n[${name}]\n`);
}

// ---------------------------------------------------------------------------
// Mock provider factory — creates a minimal ProviderAdapter for registry tests
// ---------------------------------------------------------------------------

function mockProvider(id, available = true) {
  return {
    id,
    displayName: `Mock ${id}`,
    checkAvailability: () => ({
      available,
      reason: available ? undefined : `${id} disabled for test`,
    }),
    getCapabilities: () => ({
      supportsSessionResume: false,
      supportsUserInput: false,
      supportsFleetMode: false,
      supportsCredentialRotation: false,
      maxConcurrency: 1,
    }),
    spawn: async () => {},
    abort: async () => true,
    shutdown: async () => {},
    getStats: () => ({}),
  };
}

// ---------------------------------------------------------------------------
// We need a fresh ProviderRegistry per test to avoid singleton pollution.
// The built module exports a singleton, so we construct a fresh one manually.
// ---------------------------------------------------------------------------

async function createFreshRegistry() {
  // ProviderRegistry class is not directly exported, but parseChainString is.
  // We'll dynamically import and extract from the module to get the class.
  // Since the built file exports `providerRegistry` (singleton) and `parseChainString`,
  // we need to work around the singleton pattern.

  // Strategy: import the module source and instantiate a new class.
  // The class is not exported, but we can create a minimal registry with the same logic.

  // Actually, let's just build a minimal registry that mirrors the real one,
  // using canRunModel from models.js which IS the function under test.

  class TestRegistry {
    constructor() {
      this.providers = new Map();
      this.chain = [];
    }

    register(provider) {
      this.providers.set(provider.id, provider);
    }

    configureChain(entries) {
      this.chain = entries;
    }

    selectProvider(preferredProviderId, model) {
      if (preferredProviderId) {
        const idx = this.chain.findIndex(e => e.id === preferredProviderId);
        if (idx >= 0) {
          const provider = this.providers.get(preferredProviderId);
          if (provider) {
            if (model && !canRunModel(model, preferredProviderId)) {
              // skip
            } else {
              const availability = provider.checkAvailability();
              if (availability.available) {
                return { provider, chainIndex: idx };
              }
            }
          }
        }
      }

      for (let i = 0; i < this.chain.length; i++) {
        const entry = this.chain[i];
        if (entry.fallbackOnly) continue;

        const provider = this.providers.get(entry.id);
        if (!provider) continue;

        if (model && !canRunModel(model, entry.id)) continue;

        const availability = provider.checkAvailability();
        if (availability.available) {
          return { provider, chainIndex: i };
        }
      }

      for (let i = 0; i < this.chain.length; i++) {
        const entry = this.chain[i];
        if (!entry.fallbackOnly) continue;

        const provider = this.providers.get(entry.id);
        if (!provider) continue;

        if (model && !canRunModel(model, entry.id)) continue;

        const availability = provider.checkAvailability();
        if (availability.available) {
          return { provider, chainIndex: i };
        }
      }

      return null;
    }

    selectFallback(failedProviderId, model) {
      const failedIndex = this.chain.findIndex(e => e.id === failedProviderId);
      const startIndex = failedIndex >= 0 ? failedIndex + 1 : 0;

      for (let i = startIndex; i < this.chain.length; i++) {
        const entry = this.chain[i];
        const provider = this.providers.get(entry.id);
        if (!provider) continue;

        if (model && !canRunModel(model, entry.id)) continue;

        const availability = provider.checkAvailability();
        if (availability.available) {
          return { provider, chainIndex: i };
        }
      }

      return null;
    }
  }

  return new TestRegistry();
}

// ---------------------------------------------------------------------------
// Suppress console.error from registry internals during tests
// ---------------------------------------------------------------------------

const origConsoleError = console.error;
console.error = () => {};

// ===========================================================================
// TEST SUITE
// ===========================================================================

async function main() {
  process.stdout.write('Model-Provider Compatibility Tests\n');
  process.stdout.write('='.repeat(40) + '\n');

  // =========================================================================
  // 1. canRunModel() unit tests
  // =========================================================================

  section('canRunModel() — Claude models');

  await test('claude-sonnet-4.6 can run on claude-cli', () => {
    assertEqual(canRunModel('claude-sonnet-4.6', 'claude-cli'), true, 'claude-sonnet on claude-cli');
  });

  await test('claude-sonnet-4.6 can run on copilot', () => {
    assertEqual(canRunModel('claude-sonnet-4.6', 'copilot'), true, 'claude-sonnet on copilot');
  });

  await test('claude-sonnet-4.6 CANNOT run on codex', () => {
    assertEqual(canRunModel('claude-sonnet-4.6', 'codex'), false, 'claude-sonnet on codex');
  });

  await test('claude-opus-4.6 can run on claude-cli', () => {
    assertEqual(canRunModel('claude-opus-4.6', 'claude-cli'), true, 'claude-opus on claude-cli');
  });

  await test('claude-opus-4.6 can run on copilot', () => {
    assertEqual(canRunModel('claude-opus-4.6', 'copilot'), true, 'claude-opus on copilot');
  });

  await test('claude-opus-4.6 CANNOT run on codex', () => {
    assertEqual(canRunModel('claude-opus-4.6', 'codex'), false, 'claude-opus on codex');
  });

  section('canRunModel() — GPT models');

  await test('gpt-5.4-xhigh can run on codex', () => {
    assertEqual(canRunModel('gpt-5.4-xhigh', 'codex'), true, 'gpt-5.4-xhigh on codex');
  });

  await test('gpt-5.4-xhigh can run on copilot', () => {
    assertEqual(canRunModel('gpt-5.4-xhigh', 'copilot'), true, 'gpt-5.4-xhigh on copilot');
  });

  await test('gpt-5.4-xhigh can run on claude-cli (cross-family fallback)', () => {
    assertEqual(canRunModel('gpt-5.4-xhigh', 'claude-cli'), true, 'gpt-5.4-xhigh on claude-cli');
  });

  await test('gpt-5.4-medium can run on codex', () => {
    assertEqual(canRunModel('gpt-5.4-medium', 'codex'), true, 'gpt-5.4-medium on codex');
  });

  section('canRunModel() — unknown models');

  await test('unknown model returns true (let provider decide)', () => {
    assertEqual(canRunModel('some-future-model', 'codex'), true, 'unknown on codex');
  });

  await test('unknown model returns true for claude-cli', () => {
    assertEqual(canRunModel('some-future-model', 'claude-cli'), true, 'unknown on claude-cli');
  });

  // =========================================================================
  // 2. getPreferredProvider() routing
  // =========================================================================

  section('getPreferredProvider() — model-family routing');

  await test('gpt-5.4-xhigh prefers codex', () => {
    assertEqual(getPreferredProvider('gpt-5.4-xhigh'), 'codex', 'gpt-5.4-xhigh preferred');
  });

  await test('claude-sonnet-4.6 prefers claude-cli', () => {
    assertEqual(getPreferredProvider('claude-sonnet-4.6'), 'claude-cli', 'claude-sonnet preferred');
  });

  await test('claude-opus-4.6 prefers claude-cli', () => {
    assertEqual(getPreferredProvider('claude-opus-4.6'), 'claude-cli', 'claude-opus preferred');
  });

  await test('unknown model defaults to claude-cli (claude family fallback)', () => {
    assertEqual(getPreferredProvider('mystery-model'), 'claude-cli', 'unknown preferred');
  });

  // =========================================================================
  // 3. resolveModelForProvider() — translation
  // =========================================================================

  section('resolveModelForProvider() — model name translation');

  await test('gpt-5.4-xhigh on codex → gpt-5.4', () => {
    assertEqual(resolveModelForProvider('gpt-5.4-xhigh', 'codex'), 'gpt-5.4', 'xhigh codex translation');
  });

  await test('gpt-5.4-xhigh on copilot → gpt-5.4 (xhigh)', () => {
    assertEqual(resolveModelForProvider('gpt-5.4-xhigh', 'copilot'), 'gpt-5.4 (xhigh)', 'xhigh copilot translation');
  });

  await test('gpt-5.4-xhigh on claude-cli → claude-opus-4.6 (cross-family)', () => {
    assertEqual(resolveModelForProvider('gpt-5.4-xhigh', 'claude-cli'), 'claude-opus-4.6', 'xhigh claude translation');
  });

  await test('claude-sonnet-4.6 on claude-cli → claude-sonnet-4.6', () => {
    assertEqual(resolveModelForProvider('claude-sonnet-4.6', 'claude-cli'), 'claude-sonnet-4.6', 'sonnet claude translation');
  });

  await test('unknown model returns canonical name unchanged', () => {
    assertEqual(resolveModelForProvider('mystery-model', 'codex'), 'mystery-model', 'unknown passthrough');
  });

  // =========================================================================
  // 4. selectProvider() with model compatibility
  // =========================================================================

  section('selectProvider() — model-provider compatibility');

  await test('claude-sonnet-4.6: preferred claude-cli available → selects claude-cli directly (even if fallback-only)', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('claude-cli', 'claude-sonnet-4.6');
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'claude-cli', 'preferred provider used directly');
  });

  await test('claude-sonnet-4.6: no preferred, chain walk → skips codex (incompatible), selects copilot', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider(undefined, 'claude-sonnet-4.6');
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'copilot', 'should select copilot');
  });

  await test('claude-sonnet-4.6: codex disabled, copilot disabled, claude-cli available → uses claude-cli fallback', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', false));
    reg.register(mockProvider('copilot', false));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('claude-cli', 'claude-sonnet-4.6');
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'claude-cli', 'should fall through to claude-cli');
  });

  await test('claude-sonnet-4.6: claude-cli disabled, codex+copilot available → codex incompatible, selects copilot', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', false));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('claude-cli', 'claude-sonnet-4.6');
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'copilot', 'should select copilot (codex can\'t run claude model)');
  });

  await test('claude-sonnet-4.6: only codex available → returns null (incompatible)', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', false));
    reg.register(mockProvider('claude-cli', false));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('claude-cli', 'claude-sonnet-4.6');
    assertEqual(result, null, 'should return null — no compatible provider');
  });

  await test('gpt-5.4-xhigh: default chain → selects codex (preferred)', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('codex', 'gpt-5.4-xhigh');
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'codex', 'should select codex');
  });

  await test('gpt-5.4-xhigh: codex disabled → falls to copilot', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', false));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('codex', 'gpt-5.4-xhigh');
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'copilot', 'should fall to copilot');
  });

  await test('no model specified: default chain → selects first available (codex)', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('codex', undefined);
    assert(result !== null, 'should find a provider');
    assertEqual(result.provider.id, 'codex', 'should select codex');
  });

  await test('all providers disabled → returns null', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', false));
    reg.register(mockProvider('copilot', false));
    reg.register(mockProvider('claude-cli', false));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectProvider('codex', 'gpt-5.4-xhigh');
    assertEqual(result, null, 'should return null');
  });

  // =========================================================================
  // 5. selectFallback() with model compatibility
  // =========================================================================

  section('selectFallback() — model-aware fallback');

  await test('gpt-5.4-xhigh: codex fails → falls to copilot', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectFallback('codex', 'gpt-5.4-xhigh');
    assert(result !== null, 'should find fallback');
    assertEqual(result.provider.id, 'copilot', 'should fall to copilot');
  });

  await test('gpt-5.4-xhigh: codex fails, copilot unavailable → falls to claude-cli (cross-family translation exists)', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', false));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectFallback('codex', 'gpt-5.4-xhigh');
    assert(result !== null, 'should find fallback');
    assertEqual(result.provider.id, 'claude-cli', 'should fall to claude-cli');
  });

  await test('claude-sonnet-4.6: copilot fails → skips codex (incompatible), uses claude-cli', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    // Chain where copilot is first for this scenario
    reg.configureChain(parseChainString('copilot,codex,!claude-cli'));

    const result = reg.selectFallback('copilot', 'claude-sonnet-4.6');
    assert(result !== null, 'should find fallback');
    assertEqual(result.provider.id, 'claude-cli', 'should skip codex, use claude-cli');
  });

  await test('claude-sonnet-4.6: claude-cli fails → no further fallback', async () => {
    const reg = await createFreshRegistry();
    reg.register(mockProvider('codex', true));
    reg.register(mockProvider('copilot', true));
    reg.register(mockProvider('claude-cli', true));
    reg.configureChain(parseChainString('codex,copilot,!claude-cli'));

    const result = reg.selectFallback('claude-cli', 'claude-sonnet-4.6');
    assertEqual(result, null, 'no fallback after claude-cli (end of chain)');
  });

  // =========================================================================
  // 6. parseChainString()
  // =========================================================================

  section('parseChainString() — chain parsing');

  await test('default chain: codex,copilot,!claude-cli', () => {
    const chain = parseChainString('codex,copilot,!claude-cli');
    assertEqual(chain.length, 3, 'chain length');
    assertEqual(chain[0].id, 'codex', 'first entry');
    assertEqual(chain[0].fallbackOnly, false, 'codex not fallback-only');
    assertEqual(chain[1].id, 'copilot', 'second entry');
    assertEqual(chain[1].fallbackOnly, false, 'copilot not fallback-only');
    assertEqual(chain[2].id, 'claude-cli', 'third entry');
    assertEqual(chain[2].fallbackOnly, true, 'claude-cli is fallback-only');
  });

  await test('single provider chain', () => {
    const chain = parseChainString('codex');
    assertEqual(chain.length, 1, 'chain length');
    assertEqual(chain[0].id, 'codex', 'single entry');
    assertEqual(chain[0].fallbackOnly, false, 'not fallback-only');
  });

  await test('all fallback-only', () => {
    const chain = parseChainString('!codex,!copilot,!claude-cli');
    assert(chain.every(e => e.fallbackOnly), 'all should be fallback-only');
  });

  await test('whitespace handling', () => {
    const chain = parseChainString(' codex , copilot , !claude-cli ');
    assertEqual(chain.length, 3, 'chain length after trim');
    assertEqual(chain[0].id, 'codex', 'trimmed first entry');
  });

  // =========================================================================
  // 7. resolveModel() — result type and alias resolution
  // =========================================================================

  section('resolveModel() — result type');

  await test('canonical model returns ok result', () => {
    const r = resolveModel('gpt-5.4-xhigh');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'gpt-5.4-xhigh', 'canonical model');
    assertEqual(r.resolution.resolvedFrom, undefined, 'no alias');
  });

  await test('undefined model returns default (gpt-5.4-high)', () => {
    const r = resolveModel(undefined);
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'gpt-5.4-high', 'default model');
  });

  await test('claude-opus-4.6 returns ok result', () => {
    const r = resolveModel('claude-opus-4.6');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'claude-opus-4.6', 'canonical model');
  });

  await test('unknown model returns error', () => {
    const r = resolveModel('banana');
    assert(r.ok === false, 'should not be ok');
    assert(r.error.error.includes('banana'), 'error mentions the model');
    assert(r.error.help.includes('INVALID MODEL'), 'help has guidance');
    assert(r.error.help.includes('gpt-5.4-xhigh'), 'help lists valid models');
  });

  section('resolveModel() — alias resolution');

  await test('sonnet → claude-sonnet-4.6', () => {
    const r = resolveModel('sonnet');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'claude-sonnet-4.6', 'resolved model');
    assertEqual(r.resolution.resolvedFrom, 'sonnet', 'resolvedFrom set');
  });

  await test('opus → claude-opus-4.6', () => {
    const r = resolveModel('opus');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'claude-opus-4.6', 'resolved model');
    assertEqual(r.resolution.resolvedFrom, 'opus', 'resolvedFrom set');
  });

  await test('gpt-5.4 → gpt-5.4-high', () => {
    const r = resolveModel('gpt-5.4');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'gpt-5.4-high', 'resolved model');
    assertEqual(r.resolution.resolvedFrom, 'gpt-5.4', 'resolvedFrom set');
  });

  await test('o4-mini → gpt-5.4-medium', () => {
    const r = resolveModel('o4-mini');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'gpt-5.4-medium', 'resolved model');
  });

  await test('SONNET (uppercase) → claude-sonnet-4.6 (case-insensitive)', () => {
    const r = resolveModel('SONNET');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'claude-sonnet-4.6', 'resolved model');
  });

  await test('claude-sonnet alias → claude-sonnet-4.6', () => {
    const r = resolveModel('claude-sonnet');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'claude-sonnet-4.6', 'resolved model');
  });

  await test('default alias → gpt-5.4-high', () => {
    const r = resolveModel('default');
    assert(r.ok === true, 'should be ok');
    assertEqual(r.resolution.model, 'gpt-5.4-high', 'resolved model');
  });

  await test('all aliases resolve to valid canonical models', () => {
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      const r = resolveModel(alias);
      assert(r.ok === true, `alias '${alias}' should resolve ok`);
      assertEqual(r.resolution.model, target, `alias '${alias}' target`);
    }
  });

  // =========================================================================
  // 8. getAvailableModelIds() and getModelOverride()
  // =========================================================================

  section('getAvailableModelIds() — dynamic enum');

  await test('returns all 5 models when no provider checker set', () => {
    const ids = getAvailableModelIds();
    assertEqual(ids.length, 5, 'model count');
    assert(ids.includes('gpt-5.4-xhigh'), 'has gpt-5.4-xhigh');
    assert(ids.includes('gpt-5.4-high'), 'has gpt-5.4-high');
    assert(ids.includes('gpt-5.4-medium'), 'has gpt-5.4-medium');
    assert(ids.includes('claude-sonnet-4.6'), 'has claude-sonnet-4.6');
    assert(ids.includes('claude-opus-4.6'), 'has claude-opus-4.6');
  });

  await test('MODEL_IDS has exactly 5 entries', () => {
    assertEqual(MODEL_IDS.length, 5, 'MODEL_IDS count');
  });

  section('getModelOverride() — env var');

  await test('returns undefined when MODEL_OVERRIDE not set', () => {
    assertEqual(getModelOverride(), undefined, 'should be undefined');
  });

  // =========================================================================
  // Summary
  // =========================================================================

  console.error = origConsoleError;

  process.stdout.write('\n' + '='.repeat(40) + '\n');
  process.stdout.write(`Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.stdout.write('\nFAIL\n');
    process.exit(1);
  } else {
    process.stdout.write('\nPASS\n');
  }
}

main().catch((err) => {
  console.error = origConsoleError;
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
