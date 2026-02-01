# Step 2: Distinguish Timeout Root Causes

## Context
Timeouts can mean different failure modes. We need explicit categories and signals to separate them.

## Pre-Work Thinking
### Expectations
- Hard timeout, dead process, stall, and restart interruption are currently conflated.
- Decision: define signals for each cause and required telemetry.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| warpgrep | Locate health checks | process liveness, recover-orphaned logic |
| read_file | Understand persistence | task-persistence, task-manager |

## Success Criteria
- [ ] Root cause categories and distinguishing signals defined.
- [ ] Missing telemetry requirements captured.

## Dependencies
- Depends on: Step 1
- Blocks: Step 3

## Post-Work (FILLED DURING EXECUTION)
To be filled during execution.
