# Timeout Durability Notes

## What changed
- Task state now records last output and heartbeat timestamps.
- Timeout events record a reason and context for diagnosis.
- `get_status` and `stream_output` provide stall-aware guidance.
- `recover_task` can resume timed_out tasks when a session is available.

## Timeout reasons
- hard_timeout: Task exceeded configured timeout.
- stall: No output for a long interval before timeout.
- process_dead: Process died unexpectedly.
- server_restart: Server restarted while task was running.

## Recovery workflow
1. Run `get_status` to see timeout reason and session availability.
2. If session_id is present, use `recover_task` or `resume_task`.
3. If no session_id, re-run with `spawn_task` (optionally with a higher timeout).
4. If the process is still alive after timeout, `recover_task` will attempt cleanup.

## Manual verification checklist
- Spawn a task with a very small timeout and confirm status becomes timed_out.
- Verify `get_status` shows timeout reason and suggested action.
- Confirm `stream_output` shows stall warning if no output for a while.
- If a session_id is present, call `recover_task` and verify a new task starts.

## Notes
- Timed out tasks are removed after the task TTL window; recover before expiration.
