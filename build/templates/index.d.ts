export declare const TASK_TYPES: {
    readonly 'super-coder': "super coder for all coding tasks";
    readonly 'super-planner': "super planner for all planning tasks";
    readonly 'super-researcher': "super researcher for answering any question";
    readonly 'super-tester': "super tester to test stuff properly";
};
export type TaskType = keyof typeof TASK_TYPES;
export declare const TASK_TYPE_IDS: TaskType[];
export declare function isValidTaskType(type: string): type is TaskType;
export declare function applyTemplate(taskType: TaskType, userPrompt: string): string;
//# sourceMappingURL=index.d.ts.map