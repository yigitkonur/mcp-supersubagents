export declare const spawnTaskTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            prompt: {
                type: string;
                description: string;
            };
            task_type: {
                type: string;
                enum: ("executor" | "researcher" | "codebase-researcher" | "bug-researcher" | "architect" | "planner" | "turkish")[];
                description: string;
            };
            timeout: {
                type: string;
                description: string;
            };
            cwd: {
                type: string;
                description: string;
            };
            model: {
                type: string;
                enum: ("claude-sonnet-4" | "claude-sonnet-4.5" | "claude-haiku-4.5" | "claude-opus-4.5")[];
                description: string;
            };
            silent: {
                type: string;
                description: string;
            };
            autonomous: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleSpawnTask(args: unknown): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
//# sourceMappingURL=spawn-task.d.ts.map