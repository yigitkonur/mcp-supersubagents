export const MODELS = {
  'claude-sonnet-4.6': 'Claude Sonnet 4.6 — balanced speed and capability (default)',
  'claude-opus-4.6': 'Claude Opus 4.6 — maximum capability for complex reasoning',
  'gpt-5.3-codex-xhigh': 'GPT-5.3 Codex — maximum reasoning effort',
  'gpt-5.3-codex-medium': 'GPT-5.3 Codex — balanced reasoning effort',
} as const;

export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4.6';
export const OPUS_MODEL: ModelId = 'claude-opus-4.6';

// All model IDs exposed in tool schema enums — no gating
export const MODEL_IDS: ModelId[] = [
  'claude-sonnet-4.6',
  'claude-opus-4.6',
  'gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-medium',
];

// All accepted model values for backend Zod validation (canonical names only, no aliases)
export const ALL_ACCEPTED_MODELS: readonly ModelId[] = [...MODEL_IDS] as const;

// ---------------------------------------------------------------------------
// Model family + provider routing
// ---------------------------------------------------------------------------

export type ModelFamily = 'claude' | 'codex';

/** Determine the model family from its canonical name. */
export function getModelFamily(model: string): ModelFamily {
  return model.startsWith('gpt-5.3-codex') ? 'codex' : 'claude';
}

/**
 * Return the preferred provider ID for a given model.
 * Codex models prefer the codex provider; Claude models use default chain.
 */
export function getPreferredProvider(model: string): string | undefined {
  return getModelFamily(model) === 'codex' ? 'codex' : undefined;
}

// ---------------------------------------------------------------------------
// Per-provider model name translation
// ---------------------------------------------------------------------------

/**
 * Different SDKs need different model name formats for the same canonical model.
 * This table maps canonical model → per-provider format.
 *
 * - codex SDK:       "gpt-5.3-codex xhigh"    (space, no parens)
 * - copilot SDK:     "gpt-5.3-codex (xhigh)"  (parens)
 * - claude-cli:      falls back to Claude equivalent
 */
type TranslatedModelId = 'gpt-5.3-codex-xhigh' | 'gpt-5.3-codex-medium';
type ProviderTarget = 'codex' | 'copilot' | 'claude-cli';

const MODEL_PROVIDER_MAP: Record<TranslatedModelId, Record<ProviderTarget, string>> = {
  'gpt-5.3-codex-xhigh': {
    codex:        'gpt-5.3-codex xhigh',
    copilot:      'gpt-5.3-codex (xhigh)',
    'claude-cli': 'claude-opus-4.6',       // xhigh fallback → opus
  },
  'gpt-5.3-codex-medium': {
    codex:        'gpt-5.3-codex medium',
    copilot:      'gpt-5.3-codex (medium)',
    'claude-cli': 'claude-sonnet-4.6',     // medium fallback → sonnet
  },
};

/**
 * Translate a canonical model name to the format expected by a specific provider.
 * Returns the canonical name unchanged if no translation is defined.
 */
export function resolveModelForProvider(model: string, providerId: string): string {
  const map = MODEL_PROVIDER_MAP[model as TranslatedModelId];
  if (!map) return model;
  return map[providerId as ProviderTarget] ?? model;
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
  // super-planner is always opus — user cannot override
  if (taskType === 'super-planner') return OPUS_MODEL;

  if (!requested) return DEFAULT_MODEL;

  // Direct match against known models
  if (requested in MODELS) {
    return requested as ModelId;
  }

  return DEFAULT_MODEL;
}
