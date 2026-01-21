export declare const TASK_TYPES: {
    readonly executor: "General task executor";
    readonly researcher: "Web/GitHub research";
    readonly 'codebase-researcher': "Codebase search";
    readonly 'bug-researcher': "Bug analysis";
    readonly architect: "System design";
    readonly planner: "Task planning";
    readonly turkish: "Turkish responses";
};
export type TaskType = keyof typeof TASK_TYPES;
export declare const TASK_TYPE_IDS: TaskType[];
export declare function isValidTaskType(type: string): type is TaskType;
export declare function applyTemplate(taskType: TaskType, userPrompt: string): string;
//# sourceMappingURL=index.d.ts.map