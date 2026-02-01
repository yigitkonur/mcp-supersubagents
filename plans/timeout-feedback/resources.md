# Resources Used

## Files Read
- `src/config/timeouts.ts` — timeout defaults and bounds.
- `src/utils/sanitize.ts` — schema defaults for timeout.
- `src/services/process-spawner.ts` — timeout enforcement and timeoutReason/context updates.
- `src/services/task-manager.ts` — stall detection and health checks.
- `src/tools/get-status.ts` — single vs batch formatting and suggested actions.
- `src/utils/format.ts` — formatting helpers.
- `src/tools/spawn-task.ts` — timeout param description.
- `src/types.ts` — task state fields and timeout reason types.

## Research Performed
- None (internal code paths only).

## Similar Patterns Found
- Single-task get_status already includes timeout_reason and guidance; batch format omits these fields.
