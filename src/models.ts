export const MODELS = {
  'claude-sonnet-4.5': 'Latest Sonnet - best balance of speed and capability (default)',
  'claude-opus-4.5': 'Most capable - complex reasoning, large codebases',
  'claude-haiku-4.5': 'Fastest - simple tasks, quick iterations',
} as const;

export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4.5';

// ENABLE_OPUS=false by default - opus blocked unless explicitly enabled
const ENABLE_OPUS = process.env.ENABLE_OPUS === 'true';

export const MODEL_IDS: ModelId[] = ENABLE_OPUS
  ? ['claude-sonnet-4.5', 'claude-opus-4.5', 'claude-haiku-4.5']
  : ['claude-sonnet-4.5', 'claude-haiku-4.5'];

/** Validate and sanitize model selection */
export function resolveModel(requested?: string): ModelId {
  if (!requested) return DEFAULT_MODEL;
  if (requested === 'claude-opus-4.5' && !ENABLE_OPUS) return DEFAULT_MODEL;
  if (MODEL_IDS.includes(requested as ModelId)) return requested as ModelId;
  return DEFAULT_MODEL;
}
