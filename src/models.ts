export const MODELS = {
  'claude-sonnet-4.5': 'Latest Sonnet - best balance of speed and capability (default)',
  'claude-opus-4.5': 'Most capable - complex reasoning, large codebases',
  'claude-haiku-4.5': 'Fastest - simple tasks, quick iterations',
} as const;

export type ModelId = keyof typeof MODELS;
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];
export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4.5';
