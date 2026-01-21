export declare const getModelsTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            tier: {
                type: string;
                enum: string[];
                description: string;
            };
        };
        required: never[];
    };
};
export declare function handleGetModels(args: unknown): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
//# sourceMappingURL=get-models.d.ts.map