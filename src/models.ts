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
    display: 'GPT-5.4 — maximum reasoning effort',
    family: 'codex',
    effort: 'xhigh',
    providerModels: {
      codex:        'gpt-5.4',
      copilot:      'gpt-5.4 (xhigh)',
      'claude-cli': 'claude-opus-4.6',         // fallback: GPT → Opus
    },
  },
  'gpt-5.4-high': {
    display: 'GPT-5.4 — high reasoning effort (default)',
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
// Model aliases — shortcuts that resolve to canonical model IDs
// ---------------------------------------------------------------------------

export const MODEL_ALIASES: Record<string, string> = {
  // GPT-5.4 shortcuts
  'gpt-5.4':           'gpt-5.4-high',
  'gpt5.4':            'gpt-5.4-high',
  'gpt-5.4-max':       'gpt-5.4-xhigh',
  // Claude shortcuts
  'sonnet':            'claude-sonnet-4.6',
  'claude-sonnet':     'claude-sonnet-4.6',
  'sonnet-4.6':        'claude-sonnet-4.6',
  'opus':              'claude-opus-4.6',
  'claude-opus':       'claude-opus-4.6',
  'opus-4.6':          'claude-opus-4.6',
  // Legacy / common names
  'o4-mini':           'gpt-5.4-medium',
  'default':           'gpt-5.4-high',
};

// ---------------------------------------------------------------------------
// Derived exports — all computed from MODEL_REGISTRY
// ---------------------------------------------------------------------------

/** Display-name map (canonical name → description). Used by tool schemas. */
export const MODELS: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_REGISTRY).map(([id, entry]) => [id, entry.display]),
);

export type ModelId = keyof typeof MODEL_REGISTRY & string;
export const DEFAULT_MODEL: ModelId = 'gpt-5.4-high';
export const OPUS_MODEL: ModelId = 'claude-opus-4.6';

/** All model IDs exposed in tool schema enums. */
export const MODEL_IDS: ModelId[] = Object.keys(MODEL_REGISTRY) as ModelId[];

/** All accepted model values for Zod validation. */
export const ALL_ACCEPTED_MODELS: readonly ModelId[] = [...MODEL_IDS] as const;

// ---------------------------------------------------------------------------
// MODEL_OVERRIDE — force all requests to a single model
// ---------------------------------------------------------------------------

/** If set, ALL spawn requests use this model regardless of user input. */
const MODEL_OVERRIDE_RAW = process.env.MODEL_OVERRIDE?.trim() || undefined;

export function getModelOverride(): string | undefined {
  return MODEL_OVERRIDE_RAW;
}

// ---------------------------------------------------------------------------
// Dynamic model availability — dependency-injected to avoid circular imports
// ---------------------------------------------------------------------------

type ProviderChecker = () => {
  ids: string[];
  canRun: (model: string, pid: string) => boolean;
  isAvailable: (pid: string) => boolean;
};

let providerChecker: ProviderChecker | null = null;

/** Called by server init after providers are registered. */
export function setProviderChecker(checker: ProviderChecker): void {
  providerChecker = checker;
}

/**
 * Return model IDs that can run on at least one currently-available provider.
 * Used for dynamic MCP tool schema enum — hides models with no viable provider.
 * Falls back to all MODEL_IDS if provider checker is not set (startup race) or no providers available.
 */
export function getAvailableModelIds(): ModelId[] {
  if (!providerChecker) return MODEL_IDS;
  const { ids, canRun, isAvailable } = providerChecker();
  if (ids.length === 0) return MODEL_IDS;

  const available = MODEL_IDS.filter(modelId =>
    ids.some(pid => canRun(modelId, pid) && isAvailable(pid))
  );
  return available.length > 0 ? available : MODEL_IDS;
}

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

export interface ModelResolution {
  model: ModelId;
  /** Set when the input was an alias that got resolved */
  resolvedFrom?: string;
}

export interface ModelResolutionError {
  error: string;
  /** Markdown-formatted help text listing valid models */
  help: string;
}

export type ModelResolutionResult =
  | { ok: true; resolution: ModelResolution }
  | { ok: false; error: ModelResolutionError };

/**
 * Validate and resolve model selection.
 * Returns a result type: ok with the resolved model, or error with help text.
 * Supports canonical names and aliases (case-insensitive).
 * Respects MODEL_OVERRIDE env var — when set, forces that model for all requests.
 */
export function resolveModel(requested?: string, _taskType?: string): ModelResolutionResult {
  // MODEL_OVERRIDE forces all requests to a single model
  if (MODEL_OVERRIDE_RAW) {
    if (MODEL_OVERRIDE_RAW in MODEL_REGISTRY) {
      return { ok: true, resolution: { model: MODEL_OVERRIDE_RAW as ModelId, resolvedFrom: requested ? `override(${requested})` : undefined } };
    }
    const overrideLower = MODEL_OVERRIDE_RAW.toLowerCase();
    const overrideTarget = MODEL_ALIASES[overrideLower];
    if (overrideTarget && overrideTarget in MODEL_REGISTRY) {
      return { ok: true, resolution: { model: overrideTarget as ModelId, resolvedFrom: requested ? `override(${requested})` : undefined } };
    }
    console.error(`[models] MODEL_OVERRIDE='${MODEL_OVERRIDE_RAW}' is not a valid model — ignoring`);
  }

  if (!requested) return { ok: true, resolution: { model: DEFAULT_MODEL } };

  // Direct match against known models
  if (requested in MODEL_REGISTRY) {
    return { ok: true, resolution: { model: requested as ModelId } };
  }

  // Alias match (case-insensitive)
  const lower = requested.toLowerCase();
  const aliasTarget = MODEL_ALIASES[lower];
  if (aliasTarget) {
    return { ok: true, resolution: { model: aliasTarget as ModelId, resolvedFrom: requested } };
  }

  // No match — return error with helpful guidance
  return {
    ok: false,
    error: {
      error: `Unknown model: '${requested}'`,
      help: formatModelHelp(requested),
    },
  };
}

/**
 * Generate a markdown help message listing all valid models and aliases.
 * Used in error responses when an invalid model is provided.
 */
export function formatModelHelp(attempted: string): string {
  const modelLines = Object.entries(MODEL_REGISTRY)
    .map(([id, entry]) => `| \`${id}\` | ${entry.display} |`);
  const aliasLines = Object.entries(MODEL_ALIASES)
    .map(([alias, target]) => `| \`${alias}\` | → \`${target}\` |`);
  return [
    `❌ **INVALID MODEL:** \`${attempted}\` is not a recognized model name.`,
    '',
    '**Available models:**',
    '| Model ID | Description |',
    '|----------|-------------|',
    ...modelLines,
    '',
    '**Aliases (shortcuts):**',
    '| Alias | Resolves to |',
    '|-------|-------------|',
    ...aliasLines,
    '',
    '**How model routing works:**',
    '- GPT models → Codex provider first, then Copilot, then Claude as fallback',
    '- Claude models → Claude CLI first, then Copilot',
    `- Omit \`model\` entirely to use the default (\`${DEFAULT_MODEL}\`)`,
  ].join('\n');
}

/**
 * Generate a markdown table showing which providers can run a specific model.
 * Used in "no compatible provider" error messages.
 */
export function formatModelProviderTable(model: string): string {
  const entry = MODEL_REGISTRY[model];
  if (!entry) return '';
  const providers = Object.entries(entry.providerModels)
    .map(([pid, pmodel]) => `| \`${pid}\` | \`${pmodel}\` |`);
  return [
    '**Compatible providers for this model:**',
    '| Provider | SDK Model Name |',
    '|----------|---------------|',
    ...providers,
  ].join('\n');
}
