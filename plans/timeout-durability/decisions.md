# Key Decisions

## Decision 1: Add activity timestamps to TaskState
**Context:** Need to distinguish stall vs slow but healthy.
**Options:** A=No change, B=Track lastOutputAt and lastHeartbeatAt, C=External watchdog.
**Chosen:** B
**Rationale:** Minimal change with strong diagnostic value.
**Tradeoffs:** Requires updating persistence and runtime updates.

## Decision 2: Introduce timeout_reason taxonomy
**Context:** timed_out status is too generic for recovery guidance.
**Options:** A=Free-form error string only, B=Structured reason enum, C=Separate status values.
**Chosen:** B
**Rationale:** Keeps status stable while enabling precise messaging.
**Tradeoffs:** Requires mapping logic and migration defaults.

## Decision 3: Surface resume guidance for timed_out
**Context:** Session IDs are captured but not shown for timed_out tasks.
**Options:** A=No change, B=Show resume_task hint whenever sessionId exists, C=Auto-resume.
**Chosen:** B
**Rationale:** Actionable guidance without automatic behavior changes.
**Tradeoffs:** Must ensure hints are accurate and not misleading.
