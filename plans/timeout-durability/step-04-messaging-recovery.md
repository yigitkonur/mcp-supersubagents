# Step 4: Messaging and Recovery Design

## Context
Operators need actionable guidance when timeouts happen. The system should suggest resume/retry/cleanup paths where applicable.

## Pre-Work Thinking
### Expectations
- get_status lacks timed_out guidance; resume hints only shown for completed/failed.
- stream_output provides no stall signal.
- Decision: design messaging per timeout category and surface resume_task when possible.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| warpgrep | Find status output formatting | get-status, format utils |
| read_file | Identify recovery tools | resume-task, retry-task, cancel-task |

## Success Criteria
- [ ] Message templates per timeout cause defined.
- [ ] Recovery actions mapped to tools (resume_task, retry_task, cancel_task).

## Dependencies
- Depends on: Step 3
- Blocks: Step 5 (implementation tasks)

## Post-Work (FILLED DURING EXECUTION)
To be filled during execution.
