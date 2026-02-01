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
export const TASK_TIMEOUT_MIN_MS = readIntEnv('MCP_TASK_TIMEOUT_MIN_MS', 1_000);
export const TASK_TIMEOUT_MAX_MS = readIntEnv('MCP_TASK_TIMEOUT_MAX_MS', 3_600_000);
export const TASK_TIMEOUT_DEFAULT_MS = readIntEnv('MCP_TASK_TIMEOUT_MS', 600_000);
export const TASK_STALL_WARN_MS = readIntEnv('MCP_TASK_STALL_WARN_MS', 5 * 60_000);

// Copilot switch timings
export const COPILOT_SWITCH_COMMAND_TIMEOUT_MS = readIntEnv('MCP_COPILOT_SWITCH_TIMEOUT_MS', 120_000);
export const COPILOT_SWITCH_LOCK_STALE_MS = readIntEnv('MCP_COPILOT_SWITCH_LOCK_STALE_MS', 150_000);
export const COPILOT_SWITCH_LOCK_TIMEOUT_MS = readIntEnv('MCP_COPILOT_SWITCH_LOCK_TIMEOUT_MS', 150_000);
export const COPILOT_SWITCH_LOCK_POLL_MS = readIntEnv('MCP_COPILOT_SWITCH_LOCK_POLL_MS', 500);
