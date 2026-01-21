export declare const MODELS: {
    readonly 'claude-sonnet-4.5': "Latest Sonnet - best balance of speed and capability (default)";
    readonly 'claude-opus-4.5': "Most capable - complex reasoning, large codebases";
    readonly 'claude-haiku-4.5': "Fastest - simple tasks, quick iterations";
};
export type ModelId = keyof typeof MODELS;
export declare const MODEL_IDS: ModelId[];
export declare const DEFAULT_MODEL: ModelId;
//# sourceMappingURL=models.d.ts.map