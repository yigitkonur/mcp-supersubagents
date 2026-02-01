# Resources Used

## Files Read
- `src/services/task-manager.ts` — task lifecycle, health checks, persistence triggers, sessionId capture.
- `src/services/process-spawner.ts` — execa usage, timeout enforcement, status updates, rate-limit fallback.
- `src/services/task-persistence.ts` — JSON storage, orphaned task recovery.
- `src/services/retry-queue.ts` — rate-limit detection and retry scheduling.
- `src/tools/get-status.ts` — status formatting and timeout info exposure.
- `src/tools/spawn-task.ts` — timeout inputs, task creation flow.
- `src/tools/resume-task.ts` — resume behavior and timeout input.
- `src/tools/stream-output.ts` — output streaming and lack of stall signals.
- `src/tools/retry-task.ts` — manual retry for rate-limited tasks.
- `src/tools/force-start.ts` — dependency bypass behavior.
- `src/tools/clear-tasks.ts` — task cleanup behavior.
- `src/utils/sanitize.ts` — default timeout and validation.
- `src/utils/format.ts` — status formatting helpers.
- `src/utils/task-id-generator.ts` — task ID generation.
- `src/index.ts` — server wiring and initialization.

## Research Performed
- None (no external research required).

## Similar Patterns Found
- Rate-limited retry flow via retry-queue and task-manager auto-retry.
