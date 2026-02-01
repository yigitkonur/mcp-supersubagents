# Step 2: Root Cause Map

## Context
Users see “timed out” without reason in batch get_status output. Identify why the information is missing.

## Pre-Work Thinking
### Expectations
- Batch output likely omits timeout reason details for brevity.
- Single-task output includes detailed reasoning; batch format is minimal.
- Decision: compare single vs batch rendering in get-status.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| warpgrep | Find formatting | "get_status format batch single" |
| read_file | Understand | `src/tools/get-status.ts` |
| read_file | Understand | `src/utils/format.ts` |

## Success Criteria
- [ ] Explain why timeout reason is not shown in batch output.
- [ ] Identify the exact code path that drops the detail.

## Dependencies
- Depends on: Step 1
- Blocks: Step 3

## Post-Work (FILLED DURING EXECUTION)

