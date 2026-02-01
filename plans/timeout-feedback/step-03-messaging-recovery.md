# Step 3: Timeout Messaging + Recovery Guidance

## Context
Batch get_status should provide timeout reason and next action guidance without overwhelming output.

## Pre-Work Thinking
### Expectations
- Provide a concise reason per task and optional guidance block.
- Keep batch table compact but add an extra column or appendix for timed_out tasks.
- Decision: propose a batch “Reason” column + a timed_out guidance section.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| read_file | Understand | `src/tools/get-status.ts` |
| read_file | Understand | `src/utils/format.ts` |

## Success Criteria
- [ ] Proposed batch output includes timeout_reason and suggested action.
- [ ] Guidance text maps to timeoutReason values.

## Dependencies
- Depends on: Step 2
- Blocks: Step 4

## Post-Work (FILLED DURING EXECUTION)

