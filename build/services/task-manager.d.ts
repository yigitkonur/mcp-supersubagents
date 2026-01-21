import { TaskState, TaskStatus } from '../types.js';
declare class TaskManager {
    private tasks;
    private cleanupInterval;
    constructor();
    private startCleanup;
    private cleanup;
    createTask(prompt: string, cwd?: string, model?: string, options?: {
        autonomous?: boolean;
        isResume?: boolean;
    }): TaskState;
    getTask(id: string): TaskState | null;
    updateTask(id: string, updates: Partial<TaskState>): TaskState | null;
    appendOutput(id: string, line: string): void;
    getAllTasks(statusFilter?: TaskStatus): TaskState[];
    cancelTask(id: string): boolean;
    shutdown(): void;
}
export declare const taskManager: TaskManager;
export {};
//# sourceMappingURL=task-manager.d.ts.map