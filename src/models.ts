import type { Provider } from './types.js';

// ---------------------------------------------------------------------------
// Model Family
// ---------------------------------------------------------------------------

export type ModelFamily = 'claude' | 'codex';

// ---------------------------------------------------------------------------
// Model Registry — single source of truth for all model metadata
// ---------------------------------------------------------------------------
// To add a model: add one entry here. Everything else is derived automatically.

interface ModelEntry {
  /** Human-readable description shown in tool schema */
  display: string;
  /** Provider family — drives preferred-provider routing */
  family: ModelFamily;
  /** Embedded reasoning effort extracted from the canonical name (undefined for Claude models) */
  effort?: string;
  /** Per-provider translated model name. Key = provider id, value = what the SDK expects. */
  providerModels: Partial<Record<Provider, string>>;
}

const MODEL_REGISTRY: Record<string, ModelEntry> = {
  // --- GPT-5.4 (Codex family) ---
  'gpt-5.4-xhigh': {
    display: 'GPT-5.4 — maximum reasoning effort (default)',
    family: 'codex',
    effort: 'xhigh',
    providerModels: {
      codex:        'gpt-5.4',
      copilot:      'gpt-5.4 (xhigh)',
      'claude-cli': 'claude-opus-4.6',         // fallback: GPT → Opus
    },
  },
  'gpt-5.4-high': {
    display: 'GPT-5.4 — high reasoning effort',
    family: 'codex',
    effort: 'high',
    providerModels: {
      codex:        'gpt-5.4',
      copilot:      'gpt-5.4 (high)',
      'claude-cli': 'claude-opus-4.6',
    },
  },
  'gpt-5.4-medium': {
    display: 'GPT-5.4 — balanced reasoning effort',
    family: 'codex',
    effort: 'medium',
    providerModels: {
      codex:        'gpt-5.4',
      copilot:      'gpt-5.4 (medium)',
      'claude-cli': 'claude-sonnet-4.6',
    },
  },

  // --- GPT-5.3 Codex (Codex family) ---
  'gpt-5.3-codex-xhigh': {
    display: 'GPT-5.3 Codex — maximum reasoning effort',
    family: 'codex',
    effort: 'xhigh',
    providerModels: {
      codex:        'gpt-5.3-codex',
      copilot:      'gpt-5.3-codex (xhigh)',
      'claude-cli': 'claude-opus-4.6',
    },
  },
  'gpt-5.3-codex-medium': {
    display: 'GPT-5.3 Codex — balanced reasoning effort',
    family: 'codex',
    effort: 'medium',
    providerModels: {
      codex:        'gpt-5.3-codex',
      copilot:      'gpt-5.3-codex (medium)',
      'claude-cli': 'claude-sonnet-4.6',
    },
  },

  // --- Claude (Claude family) ---
  'claude-sonnet-4.6': {
    display: 'Claude Sonnet 4.6 — balanced speed and capability',
    family: 'claude',
    providerModels: {
      'claude-cli': 'claude-sonnet-4.6',
      copilot:      'claude-sonnet-4.6',
    },
  },
  'claude-opus-4.6': {
    display: 'Claude Opus 4.6 — maximum capability for complex reasoning',
    family: 'claude',
    providerModels: {
      'claude-cli': 'claude-opus-4.6',
      copilot:      'claude-opus-4.6',
    },
  },
};

// ---------------------------------------------------------------------------
// Derived exports — all computed from MODEL_REGISTRY
// ---------------------------------------------------------------------------

/** Display-name map (canonical name → description). Used by tool schemas. */
export const MODELS: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_REGISTRY).map(([id, entry]) => [id, entry.display]),
);

export type ModelId = keyof typeof MODEL_REGISTRY & string;
export const DEFAULT_MODEL: ModelId = 'gpt-5.4-xhigh';
export const OPUS_MODEL: ModelId = 'claude-opus-4.6';

/** All model IDs exposed in tool schema enums. */
export const MODEL_IDS: ModelId[] = Object.keys(MODEL_REGISTRY) as ModelId[];

/** All accepted model values for Zod validation. */
export const ALL_ACCEPTED_MODELS: readonly ModelId[] = [...MODEL_IDS] as const;

// ---------------------------------------------------------------------------
// Model family + provider routing
// ---------------------------------------------------------------------------

/** Determine the model family from its canonical name. */
export function getModelFamily(model: string): ModelFamily {
  return MODEL_REGISTRY[model]?.family ?? 'claude';
}

/**
 * Return the preferred provider ID for a given model.
 * Codex-family models → codex provider. Claude-family models → claude-cli provider.
 * This ensures models route to their native provider first, with chain fallback if unavailable.
 */
export function getPreferredProvider(model: string): string | undefined {
  const family = getModelFamily(model);
  if (family === 'codex') return 'codex';
  if (family === 'claude') return 'claude-cli';
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-provider model name translation
// ---------------------------------------------------------------------------

/**
 * Translate a canonical model name to the format expected by a specific provider.
 * Returns the canonical name unchanged if no translation is defined.
 */
export function resolveModelForProvider(model: string, providerId: string): string {
  const entry = MODEL_REGISTRY[model];
  if (!entry) return model;
  return entry.providerModels[providerId as Provider] ?? model;
}

/**
 * Extract the reasoning effort embedded in a canonical model name.
 * e.g., "gpt-5.4-xhigh" → "xhigh", "gpt-5.4-medium" → "medium"
 * Returns undefined for models without embedded effort (e.g., Claude models).
 */
export function getEmbeddedReasoningEffort(model: string): string | undefined {
  return MODEL_REGISTRY[model]?.effort;
}

/**
 * Check if a provider has a translation entry for this model.
 * Returns true for unknown models (let the provider decide).
 */
export function canRunModel(model: string, providerId: string): boolean {
  const entry = MODEL_REGISTRY[model];
  if (!entry) return true;
  return providerId in entry.providerModels;
}

// ---------------------------------------------------------------------------
// Model resolution (user input → canonical ModelId)
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize model selection.
 * - super-planner always resolves to opus (no user override).
 * - Unknown models default to claude-sonnet-4.6.
 */
export function resolveModel(requested?: string, taskType?: string): ModelId {
  // super-planner defaults to xhigh reasoning — user can still override
  if (taskType === 'super-planner' && !requested) return DEFAULT_MODEL;

  if (!requested) return DEFAULT_MODEL;

  // Direct match against known models
  if (requested in MODEL_REGISTRY) {
    return requested as ModelId;
  }

  return DEFAULT_MODEL;
}
