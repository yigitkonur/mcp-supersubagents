# Step 1: Trace Timeout Flow

## Context
Need to understand where timeout defaults are configured and how they propagate into task execution and state updates.

## Pre-Work Thinking
### Expectations
- Locate the default timeout value and env overrides.
- Identify where timeout is applied to the process runner.
- Decision: follow config → sanitize → process-spawner → task-manager because that’s the data path.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| warpgrep | Find timeout flow | "timeout config default enforcement process" |
| read_file | Understand | `src/config/timeouts.ts` |
| read_file | Understand | `src/utils/sanitize.ts` |
| read_file | Understand | `src/services/process-spawner.ts` |

## Success Criteria
- [ ] Default timeout and bounds identified.
- [ ] Places where timeout is applied and stored in task state listed.

## Dependencies
- Depends on: none
- Blocks: Step 2

## Post-Work (FILLED DURING EXECUTION)

