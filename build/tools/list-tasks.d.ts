export declare const listTasksTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                enum: string[];
            };
        };
        required: never[];
    };
};
export declare function handleListTasks(args: unknown): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
//# sourceMappingURL=list-tasks.d.ts.map