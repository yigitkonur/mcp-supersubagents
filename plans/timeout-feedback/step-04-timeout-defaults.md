# Step 4: Timeout Defaults and Optional Param Guidance

## Context
Default timeout is currently 30 minutes (previously 10 minutes). User wants timeout param optional with a 30-minute default and clear guidance not to set it unless needed.

## Pre-Work Thinking
### Expectations
- Update TASK_TIMEOUT_DEFAULT_MS to 30 minutes.
- Update SpawnTaskSchema/ResumeTaskSchema default comment and tool descriptions.
- Decision: Keep bounds unchanged, only adjust default and wording.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| read_file | Understand | `src/config/timeouts.ts` |
| read_file | Understand | `src/utils/sanitize.ts` |
| read_file | Understand | `src/tools/spawn-task.ts` |
| read_file | Understand | `src/tools/resume-task.ts` |

## Success Criteria
- [ ] Default value set to 30 minutes in config/schema.
- [ ] Tool descriptions explicitly advise not to set timeout unless necessary.

## Dependencies
- Depends on: Step 1
- Blocks: Phase 4 extraction

## Post-Work (FILLED DURING EXECUTION)
