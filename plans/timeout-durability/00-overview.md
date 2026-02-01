# Plan: Timeout Durability

**Date:** 2026-02-01
**Goal:** Identify timeout root causes in the MCP task system and design durable handling with clear diagnostics, recovery, and user guidance.
**Complexity:** medium

## Scope
**In:** Task lifecycle, timeout config/enforcement, process health checks, persistence schema, get_status messaging, recovery/resume flows, diagnostic logging.
**Out:** Changes to Copilot CLI itself, external service behavior, UI/UX outside MCP tool responses.

## Phases
### Phase 1: Evidence and Root Causes (Steps 1-2)
- Step 1: Document current timeout flow and gaps
- Step 2: Distinguish root cause categories and signals
**Goal:** Evidence-backed root cause map | **Estimate:** 1-2 hours

### Phase 2: State and Diagnostics Design (Steps 3-4)
- Step 3: Define state fields for heartbeat/output/timeout reason
- Step 4: Design diagnostics and recovery actions per cause
**Goal:** Durable architecture for timeouts | **Estimate:** 2-3 hours

### Phase 3: Messaging and Recovery UX (Steps 5-6)
- Step 5: Improve get_status and stream_output guidance
- Step 6: Resume/retry/cleanup guidance for timed_out cases
**Goal:** Actionable feedback for operators | **Estimate:** 1-2 hours

## Approach
Ground the design in existing task lifecycle code, add minimal state fields needed for diagnosis, and surface recovery paths (resume_task, retry_task) when available. Prioritize persistence correctness before feature expansion.

## Risks
1. **Misclassification of timeouts** — Mitigation: add explicit timeout_reason and last_activity timestamps.
2. **State incompatibility** — Mitigation: backward-compatible persistence and schema defaults.
3. **Noisy logs** — Mitigation: throttle diagnostic logging and focus on actionable data.

## Success Metrics
- Timed_out tasks show a specific reason and a next step.
- Operators can resume or retry without manual log digging.
- No loss of task state across server restarts.
