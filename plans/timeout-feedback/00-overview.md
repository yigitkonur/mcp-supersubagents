# Plan: Timeout Feedback

**Date:** 2026-02-01
**Goal:** Identify why batch get_status hides timeout reasons, map root causes, and plan fixes including clearer timeout guidance and a 30-minute default timeout.
**Complexity:** complex

## Scope
**In:** get_status batch formatting, timeout reason/context propagation, timeout defaults, tool schema/description updates, recommended next actions.
**Out:** Implementing changes now, deployment, external platform issues.

## Phases
### Phase 1: Discover (Steps 1-2)
- Step 1: Trace timeout configuration and enforcement flow — read config/timeouts, process-spawner, task-manager.
- Step 2: Trace get_status formatting for single vs batch output — read get-status and format helpers.
**Goal:** Clear map of where timeout reasons are set and how they are surfaced.

### Phase 2: Analyze (Steps 3-4)
- Step 3: Root-cause map for missing timeout reason in batch output.
- Step 4: Identify UX gaps and recovery guidance points.
**Goal:** Pinpoint why “timed out” lacks guidance in batch results.

### Phase 3: Plan Fixes (Steps 5-6)
- Step 5: Design batch output improvements (reason + guidance + suggested action).
- Step 6: Plan default timeout change to 30 minutes and make timeout param optional with explicit warning.
**Goal:** Concrete, verifiable fix plan.

## Approach
Trace the timeout data flow from configuration → process execution → task state → get_status formatting. Compare single-task and batch rendering, then design output and default changes that minimize user confusion while preserving current behavior.

## Risks
1. **Misleading output** — Fix must not claim a reason when missing; add safe fallback.
2. **Default change impact** — Longer default may delay failure visibility; provide guidance for explicit overrides.

## Success Metrics
- Batch get_status includes timeout reason and actionable next steps for timed_out tasks.
- Timeout defaults documented and set to 30 minutes without breaking validation bounds.
