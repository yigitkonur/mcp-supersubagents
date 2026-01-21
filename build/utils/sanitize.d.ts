import { z } from 'zod';
export declare function sanitizePrompt(input: unknown): string | null;
export declare function validateCwd(cwd: unknown): string | null;
export declare const SpawnTaskSchema: z.ZodObject<{
    prompt: z.ZodString;
    timeout: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    cwd: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    task_type: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    silent: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    autonomous: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    timeout: number;
    silent: boolean;
    autonomous: boolean;
    cwd?: string | undefined;
    model?: string | undefined;
    task_type?: string | undefined;
}, {
    prompt: string;
    timeout?: number | undefined;
    cwd?: string | undefined;
    model?: string | undefined;
    task_type?: string | undefined;
    silent?: boolean | undefined;
    autonomous?: boolean | undefined;
}>;
export declare const ResumeTaskSchema: z.ZodObject<{
    sessionId: z.ZodString;
    timeout: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    cwd: z.ZodOptional<z.ZodString>;
    autonomous: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    timeout: number;
    autonomous: boolean;
    sessionId: string;
    cwd?: string | undefined;
}, {
    sessionId: string;
    timeout?: number | undefined;
    cwd?: string | undefined;
    autonomous?: boolean | undefined;
}>;
export declare const GetTaskStatusSchema: z.ZodObject<{
    taskId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    taskId: string;
}, {
    taskId: string;
}>;
export declare const ListTasksSchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<["pending", "running", "completed", "failed", "cancelled"]>>;
}, "strip", z.ZodTypeAny, {
    status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
}, {
    status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
}>;
export type SpawnTaskParams = z.infer<typeof SpawnTaskSchema>;
export type GetTaskStatusParams = z.infer<typeof GetTaskStatusSchema>;
export type ListTasksParams = z.infer<typeof ListTasksSchema>;
export type ResumeTaskParams = z.infer<typeof ResumeTaskSchema>;
//# sourceMappingURL=sanitize.d.ts.map