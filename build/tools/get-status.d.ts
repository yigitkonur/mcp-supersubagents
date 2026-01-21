export declare const getTaskStatusTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                oneOf: ({
                    type: string;
                    description: string;
                    items?: undefined;
                } | {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                })[];
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleGetTaskStatus(args: unknown): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
//# sourceMappingURL=get-status.d.ts.map