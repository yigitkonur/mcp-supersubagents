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
    cwd?: string;
    model?: string;
    autonomous?: boolean;
    isResume?: boolean;
    process?: ResultPromise;
}
export interface SpawnOptions {
    prompt: string;
    timeout?: number;
    cwd?: string;
    model?: string;
    autonomous?: boolean;
    resumeSessionId?: string;
}
//# sourceMappingURL=types.d.ts.map