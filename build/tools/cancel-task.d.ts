export declare const cancelTaskTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            taskId: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleCancelTask(args: unknown): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
//# sourceMappingURL=cancel-task.d.ts.map