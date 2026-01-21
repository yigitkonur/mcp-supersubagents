export declare const resumeTaskTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            sessionId: {
                type: string;
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
            autonomous: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleResumeTask(args: unknown): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
//# sourceMappingURL=resume-task.d.ts.map