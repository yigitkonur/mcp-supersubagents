/**
 * Claude-only model definitions for Copilot CLI
 * Only Anthropic Claude models are supported
 */
export declare const CLAUDE_MODELS: {
    readonly 'claude-sonnet-4': "Balanced performance. Great for most coding tasks. (default)";
    readonly 'claude-sonnet-4.5': "Latest Sonnet. Enhanced reasoning and coding.";
    readonly 'claude-haiku-4.5': "Fast and cheap. Good for simple tasks.";
    readonly 'claude-opus-4.5': "Most capable. Complex reasoning, large codebases.";
};
export type ClaudeModelId = keyof typeof CLAUDE_MODELS;
export declare const MODEL_IDS: ClaudeModelId[];
export declare const DEFAULT_MODEL: ClaudeModelId;
export declare function isValidModel(model: string): model is ClaudeModelId;
export declare function getModelDescription(model: ClaudeModelId): string;
export declare function formatModelsForDescription(): string;
//# sourceMappingURL=models.d.ts.map