/**
 * Centralized timeout configuration with optional environment overrides.
 */

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Task execution timeout bounds
export const TASK_TIMEOUT_MIN_MS = readIntEnv('MCP_TASK_TIMEOUT_MIN_MS', 15 * 60_000);
export const TASK_TIMEOUT_MAX_MS = readIntEnv('MCP_TASK_TIMEOUT_MAX_MS', 3_600_000);
export const TASK_TIMEOUT_DEFAULT_MS = readIntEnv('MCP_TASK_TIMEOUT_MS', 1_800_000);
export const TASK_STALL_WARN_MS = readIntEnv('MCP_TASK_STALL_WARN_MS', 15 * 60_000);

// Task retention: how long completed/failed tasks stay in memory before cleanup
export const TASK_TTL_MS = readIntEnv('MCP_TASK_TTL_MS', 3_600_000); // 1 hour

