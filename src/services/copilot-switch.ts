/**
 * Copilot account switching on rate limit.
 *
 * When a Copilot task hits a rate limit, this module rotates to the next
 * GitHub account via `~/bin/copilot-switch next`. A file-based lock ensures
 * only one switch runs at a time across all processes.
 *
 * 3 accounts are rotated in a 5-minute window. After all 3 are exhausted,
 * the caller falls through to Claude CLI fallback.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execa } from 'execa';
import { getStorageDir } from './task-persistence.js';

// ── Configuration ──────────────────────────────────────────────────

const COPILOT_SWITCH_PATH = process.env.COPILOT_SWITCH_PATH || join(homedir(), 'bin', 'copilot-switch');

// File paths (inside ~/.super-agents/)
const LOCK_PATH  = join(getStorageDir(), 'copilot-switch.lock');
const STATE_PATH = join(getStorageDir(), 'copilot-switch.json');

// Lock timing
const LOCK_STALE_MS   = 30_000;   // 30s — lock older than this is stale
const LOCK_POLL_MS    = 500;      // poll every 500ms when waiting for lock
const LOCK_TIMEOUT_MS = 15_000;   // give up waiting after 15s

// Switch window
const SWITCH_WINDOW_MS           = 5 * 60_000;  // 5-minute tracking window
const MAX_SWITCHES_IN_WINDOW     = 3;            // 3 accounts
const RECENT_SWITCH_THRESHOLD_MS = 10_000;       // 10s = "just switched, don't switch again"

// ── Types ──────────────────────────────────────────────────────────

interface SwitchLock {
  pid: number;
  timestamp: number;
}

interface SwitchState {
  lastSwitchTime: number;
  switchCount: number;
  windowStart: number;
}

export type SwitchResult =
  | { outcome: 'switched' }
  | { outcome: 'recentSwitch' }
  | { outcome: 'exhausted' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'disabled' };

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check if the copilot-switch script exists on disk.
 */
export function isSwitchAvailable(): boolean {
  try {
    return existsSync(COPILOT_SWITCH_PATH);
  } catch {
    return false;
  }
}

/**
 * Try to switch to the next Copilot account.
 *
 * - Acquires a file lock so only one process runs the switch.
 * - Other callers wait for the lock, then see `recentSwitch`.
 * - Returns `exhausted` if all 3 accounts tried in the last 5 minutes.
 * - Returns `disabled` if the switch script doesn't exist.
 */
export async function trySwitchAccount(): Promise<SwitchResult> {
  // Gate 1: Is the switch script available?
  if (!isSwitchAvailable()) {
    return { outcome: 'disabled' };
  }

  // Gate 2: Quick pre-check without lock (optimistic read)
  const preState = readState();
  if (isRecentSwitch(preState)) {
    console.error('[copilot-switch] Recent switch detected (pre-check), skipping');
    return { outcome: 'recentSwitch' };
  }
  if (isExhausted(preState)) {
    console.error('[copilot-switch] All accounts exhausted (pre-check)');
    return { outcome: 'exhausted' };
  }

  // Gate 3: Acquire lock (or wait for someone else to finish)
  const locked = acquireLock() || await waitForLock();
  if (!locked) {
    // Could not acquire lock — check if someone else switched while we waited
    const postWaitState = readState();
    if (isRecentSwitch(postWaitState)) {
      return { outcome: 'recentSwitch' };
    }
    return { outcome: 'failed', error: 'Could not acquire switch lock' };
  }

  try {
    // Gate 4: Re-check state under lock (double-check pattern)
    const state = readState();
    if (isRecentSwitch(state)) {
      console.error('[copilot-switch] Recent switch detected (under lock), skipping');
      return { outcome: 'recentSwitch' };
    }
    if (isExhausted(state)) {
      console.error('[copilot-switch] All accounts exhausted (under lock)');
      return { outcome: 'exhausted' };
    }

    // Execute the switch
    const success = await runSwitchCommand();
    if (!success) {
      return { outcome: 'failed', error: 'Switch command returned non-zero' };
    }

    // Update state
    const now = Date.now();
    const windowExpired = state.windowStart > 0 && (now - state.windowStart) > SWITCH_WINDOW_MS;
    const newState: SwitchState = {
      lastSwitchTime: now,
      switchCount: windowExpired ? 1 : state.switchCount + 1,
      windowStart: windowExpired ? now : (state.windowStart || now),
    };
    writeState(newState);

    console.error(`[copilot-switch] Switch #${newState.switchCount} in window (max ${MAX_SWITCHES_IN_WINDOW})`);
    return { outcome: 'switched' };
  } finally {
    releaseLock();
  }
}

// ── State management ───────────────────────────────────────────────

function readState(): SwitchState {
  const defaultState: SwitchState = { lastSwitchTime: 0, switchCount: 0, windowStart: 0 };
  try {
    if (!existsSync(STATE_PATH)) return defaultState;
    const data = readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(data) as SwitchState;
    if (typeof parsed.lastSwitchTime !== 'number') return defaultState;
    return parsed;
  } catch {
    return defaultState;
  }
}

function writeState(state: SwitchState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[copilot-switch] Failed to write state: ${err}`);
  }
}

function isRecentSwitch(state: SwitchState): boolean {
  return state.lastSwitchTime > 0 && (Date.now() - state.lastSwitchTime) < RECENT_SWITCH_THRESHOLD_MS;
}

function isExhausted(state: SwitchState): boolean {
  // If window has expired, not exhausted (will reset on next switch)
  if (state.windowStart > 0 && (Date.now() - state.windowStart) > SWITCH_WINDOW_MS) {
    return false;
  }
  return state.switchCount >= MAX_SWITCHES_IN_WINDOW;
}

// ── Lock management ────────────────────────────────────────────────

function acquireLock(): boolean {
  try {
    const lockData: SwitchLock = { pid: process.pid, timestamp: Date.now() };
    // 'wx' = create exclusively, fail if exists (atomic on POSIX)
    writeFileSync(LOCK_PATH, JSON.stringify(lockData), { flag: 'wx' });
    return true;
  } catch {
    return false; // File already exists (lock held by another process)
  }
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // Ignore — lock may have been broken by another process
  }
}

function isLockStale(): boolean {
  try {
    const content = readFileSync(LOCK_PATH, 'utf-8');
    const lock = JSON.parse(content) as SwitchLock;

    // Age check
    if (Date.now() - lock.timestamp > LOCK_STALE_MS) {
      console.error(`[copilot-switch] Stale lock detected (age: ${Date.now() - lock.timestamp}ms)`);
      return true;
    }

    // PID liveness check
    try {
      process.kill(lock.pid, 0); // Signal 0 = check if process exists
      return false; // PID alive, lock is valid
    } catch {
      console.error(`[copilot-switch] Stale lock detected (PID ${lock.pid} is dead)`);
      return true;
    }
  } catch {
    // Can't read/parse lock — treat as stale
    return true;
  }
}

async function waitForLock(): Promise<boolean> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Try to acquire
    if (acquireLock()) return true;

    // Check if the held lock is stale
    if (isLockStale()) {
      console.error('[copilot-switch] Breaking stale lock');
      try { unlinkSync(LOCK_PATH); } catch {}
      if (acquireLock()) return true;
    }

    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
  }

  console.error('[copilot-switch] Lock acquisition timed out');
  return false;
}

// ── Switch command execution ───────────────────────────────────────

async function runSwitchCommand(): Promise<boolean> {
  try {
    console.error('[copilot-switch] Running account switch...');
    const result = await execa(COPILOT_SWITCH_PATH, ['next'], {
      timeout: 15_000, // 15s timeout (script normally takes 4-5s)
      reject: false,
    });

    if (result.exitCode === 0) {
      console.error(`[copilot-switch] Account switch successful${result.stdout ? ': ' + result.stdout.trim() : ''}`);
      return true;
    }

    console.error(`[copilot-switch] Switch command failed (exit ${result.exitCode}): ${result.stderr}`);
    return false;
  } catch (err) {
    console.error(`[copilot-switch] Switch command error: ${err}`);
    return false;
  }
}
