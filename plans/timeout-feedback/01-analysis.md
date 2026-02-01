# Analysis

## Current State
- Timeout defaults are configured in `src/config/timeouts.ts` and used by validation in `src/utils/sanitize.ts` (default 30 minutes, previously 10 minutes).
- `src/services/process-spawner.ts` applies the timeout to execa and writes `timeoutReason` + `timeoutContext` on timeout.
- `src/services/task-manager.ts` health check can set `timeoutReason: stall` for long output gaps and records context.
- `src/tools/get-status.ts` includes `timeout_reason` and `timeout_context` in the internal result, but the **batch formatter only renders status + labels**. Single-task format includes the reason and guidance.

## Root Cause for Poor Batch Output
1. **Batch formatting omission**: `formatBatchTaskStatus` does not render timeout_reason, timeout_context, or suggested actions. Only status is shown, so “timed out (copilot)” lacks context and next steps.
2. **Default timeout was short**: 10 minutes can be too aggressive for large tasks, increasing timeouts and user frustration.

## Possible Timeout Causes (Actual Execution)
- **Hard timeout**: execa `result.timedOut` after configured timeout.
- **Stall**: no output for a long time; `timeoutReason` set to `stall` by health check or timeout handler.
- **Process dead**: health check detects missing PID and marks failed with `process_dead`.
- **Server restart**: persistence recovery marks interrupted tasks.

## Options for Batch Output Fix
A) Add a “Reason” column to the batch table (e.g., “stall”, “hard timeout”).
B) Add a follow-up section listing timed_out tasks with reason + suggested action (resume/spawn).
C) Auto-expand timed_out tasks to single-task format output.

## Decision Drivers
- Keep batch output compact but actionable.
- Avoid overwhelming users with large detail for large batch calls.
- Provide explicit next actions for timed_out tasks.
