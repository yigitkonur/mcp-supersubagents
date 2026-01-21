/**
 * Template loader for Copilot CLI tasks
 * Templates provide system prompts for different agent types
 */
export declare const TASK_TYPES: {
    readonly executor: "General executor - implements features, fixes bugs, refactors code";
    readonly researcher: "Research agent - multi-source research using web, GitHub, Reddit";
    readonly 'codebase-researcher': "Codebase researcher - finds code using semantic search";
    readonly 'bug-researcher': "Bug investigator - deep root cause analysis";
    readonly architect: "Architecture designer - system design for projects";
    readonly planner: "Implementation planner - breaks features into tasks";
    readonly turkish: "Turkish language - always responds in Turkish";
};
export type TaskType = keyof typeof TASK_TYPES;
export declare const TASK_TYPE_IDS: TaskType[];
/**
 * Load template content from .mdx file
 */
export declare function loadTemplate(taskType: TaskType): string;
/**
 * Check if task type is valid
 */
export declare function isValidTaskType(type: string): type is TaskType;
/**
 * Get task type description
 */
export declare function getTaskTypeDescription(type: TaskType): string;
/**
 * Format task types for tool description
 */
export declare function formatTaskTypesForDescription(): string;
/**
 * Combine template with user prompt
 */
export declare function applyTemplate(taskType: TaskType, userPrompt: string): string;
//# sourceMappingURL=index.d.ts.map