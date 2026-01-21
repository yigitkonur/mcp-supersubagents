/**
 * Claude-only model definitions for Copilot CLI
 * Only Anthropic Claude models are supported
 */

export const CLAUDE_MODELS = {
  'claude-sonnet-4': 'Balanced performance. Great for most coding tasks. (default)',
  'claude-sonnet-4.5': 'Latest Sonnet. Enhanced reasoning and coding.',
  'claude-haiku-4.5': 'Fast and cheap. Good for simple tasks.',
  'claude-opus-4.5': 'Most capable. Complex reasoning, large codebases.',
} as const;

export type ClaudeModelId = keyof typeof CLAUDE_MODELS;

export const MODEL_IDS = Object.keys(CLAUDE_MODELS) as ClaudeModelId[];
export const DEFAULT_MODEL: ClaudeModelId = 'claude-sonnet-4';

export function isValidModel(model: string): model is ClaudeModelId {
  return model in CLAUDE_MODELS;
}

export function getModelDescription(model: ClaudeModelId): string {
  return CLAUDE_MODELS[model];
}

export function formatModelsForDescription(): string {
  const models = MODEL_IDS.map(id => `${id}: ${CLAUDE_MODELS[id]}`).join(' | ');
  return `Models: ${models}`;
}
