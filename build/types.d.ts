import type { ResultPromise } from 'execa';
export declare enum TaskStatus {
    PENDING = "pending",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled"
}
export interface TaskState {
    id: string;
    status: TaskStatus;
    prompt: string;
    output: string[];
    pid?: number;
    sessionId?: string;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    error?: string;
    errorType?: 'auth' | 'timeout' | 'rate_limit' | 'unknown';
    cwd?: string;
    model?: string;
    silent?: boolean;
    autonomous?: boolean;
    isResume?: boolean;
    process?: ResultPromise;
}
export interface SpawnOptions {
    prompt: string;
    timeout?: number;
    cwd?: string;
    model?: string;
    silent?: boolean;
    autonomous?: boolean;
    resumeSessionId?: string;
}
export interface SpawnTaskInput {
    prompt: string;
    timeout?: number;
    cwd?: string;
    model?: string;
}
export interface GetTaskStatusInput {
    taskId: string;
}
export interface CancelTaskInput {
    taskId: string;
}
export interface ListTasksInput {
    status?: TaskStatus;
}
export interface TaskSummary {
    id: string;
    status: TaskStatus;
    prompt: string;
    startTime: string;
    endTime?: string;
    exitCode?: number;
}
//# sourceMappingURL=types.d.ts.map