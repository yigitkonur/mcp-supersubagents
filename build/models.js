/**
 * Claude-only model definitions for Copilot CLI
 * Only Anthropic Claude models are supported
 */
export const CLAUDE_MODELS = {
    'claude-sonnet-4': 'Balanced performance. Great for most coding tasks. (default)',
    'claude-sonnet-4.5': 'Latest Sonnet. Enhanced reasoning and coding.',
    'claude-haiku-4.5': 'Fast and cheap. Good for simple tasks.',
    'claude-opus-4.5': 'Most capable. Complex reasoning, large codebases.',
};
export const MODEL_IDS = Object.keys(CLAUDE_MODELS);
export const DEFAULT_MODEL = 'claude-sonnet-4';
export function isValidModel(model) {
    return model in CLAUDE_MODELS;
}
export function getModelDescription(model) {
    return CLAUDE_MODELS[model];
}
export function formatModelsForDescription() {
    const models = MODEL_IDS.map(id => `${id}: ${CLAUDE_MODELS[id]}`).join(' | ');
    return `Models: ${models}`;
}
//# sourceMappingURL=models.js.map