export const MODELS = {
  'claude-sonnet-4.6': 'Latest Sonnet 4.6 - best balance of speed and capability (default)',
  'claude-opus-4.6': 'Most capable - complex reasoning, large codebases',
  'claude-haiku-4.5': 'Fastest - simple tasks, quick iterations',
} as const;

export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4.6';
export const OPUS_MODEL: ModelId = 'claude-opus-4.6';

// ENABLE_OPUS controls VISIBILITY in tool descriptions only.
// Clients that know the word 'opus' or 'claude-opus-4.6' can always use it.
const ENABLE_OPUS = process.env.ENABLE_OPUS === 'true';

// MODEL_IDS exposed in tool schema enum — opus hidden unless ENABLE_OPUS=true
export const MODEL_IDS: ModelId[] = ENABLE_OPUS
  ? ['claude-sonnet-4.6', 'claude-opus-4.6', 'claude-haiku-4.5']
  : ['claude-sonnet-4.6', 'claude-haiku-4.5'];

// All accepted model values (always includes opus + alias) for backend validation
export const ALL_ACCEPTED_MODELS: string[] = [
  'claude-sonnet-4.6',
  'claude-opus-4.6',
  'claude-haiku-4.5',
  'opus', // alias for claude-opus-4.6
  'sonnet', // alias for claude-sonnet-4.6
  'claude-sonnet-4.5', // backward compat alias
];

/**
 * Validate and sanitize model selection.
 * - super-planner always resolves to opus (no user override).
 * - 'opus' is an alias for 'claude-opus-4.6'.
 * - 'claude-opus-4.6' and 'opus' are ALWAYS allowed regardless of ENABLE_OPUS.
 */
export function resolveModel(requested?: string, taskType?: string): ModelId {
  // super-planner is always opus — user cannot override
  if (taskType === 'super-planner') return OPUS_MODEL;

  if (!requested) return DEFAULT_MODEL;

  // 'opus' alias and 'claude-opus-4.6' always bypass ENABLE_OPUS
  if (requested === 'opus' || requested === 'claude-opus-4.6') return OPUS_MODEL;

  // 'sonnet' alias + backward compat for old name
  if (requested === 'sonnet' || requested === 'claude-sonnet-4.5') return DEFAULT_MODEL;

  if ((Object.keys(MODELS) as ModelId[]).includes(requested as ModelId)) return requested as ModelId;
  return DEFAULT_MODEL;
}
