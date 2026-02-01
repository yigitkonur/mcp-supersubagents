# Analysis

## Current State (Evidence)
- Tasks are created in memory with generated IDs and persisted to JSON under the user home directory per workspace.
- Timeout defaults to 1800000 ms for spawn and resume; execa enforces the timeout and sets status to timed_out.
- Health checks only verify process liveness; no heartbeat or last-activity timestamps exist.
- get_status provides timeout remaining for running tasks but no timed_out-specific guidance.
- Session IDs can be captured from output and used by resume_task, but timed_out does not surface that hint.
- Server restarts mark running or pending tasks as failed with a generic interruption error.

## Root Cause Categories and Signals
1. **Hard timeout exceeded**
   - Signal: TaskStatus timed_out with error text “timed out after X ms”.
   - Distinguish from: server restart and dead process via error text and endTime source.
2. **Process died (zombie or crash)**
   - Signal: health check or get_status liveness check marks task failed with “process exited unexpectedly”.
3. **Stall or no-output hang**
   - Signal: process still alive, but output and activity do not change for a long period.
   - Currently indistinguishable due to missing last-activity tracking.
4. **Server restart interruption**
   - Signal: load-time recovery marks running or pending tasks as failed with “server restarted” error.
5. **Rate-limit backoff**
   - Signal: rate_limited status with retryInfo; already handled by retry queue.

## Options
- **Option A: Increase timeout only**
  - Pros: minimal change.
  - Cons: hides root causes, doesn’t improve reliability.
- **Option B: Add diagnostics + recovery guidance (preferred)**
  - Pros: actionable feedback, durable state, clearer recovery paths.
  - Cons: requires schema and message updates.
- **Option C: Separate watchdog service**
  - Pros: robust.
  - Cons: more complexity than needed.

## Decision
Proceed with Option B: extend task state for activity and timeout reasons, improve messaging, and add recovery actions aligned with existing tools.
