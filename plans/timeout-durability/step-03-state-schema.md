# Step 3: Define State Schema and Persistence Changes

## Context
Durable timeout handling requires extra state (activity timestamps and reasons) and safe persistence.

## Pre-Work Thinking
### Expectations
- TaskState lacks last-activity fields and timeout reason taxonomy.
- Decision: add minimal fields for diagnostics and recovery while keeping JSON backward-compatible.

### Discovery Strategy
| Tool | Purpose | Query |
|------|---------|-------|
| warpgrep | Locate TaskState usage | types, task-manager, persistence |
| read_file | Understand write path | task-persistence serialization |

## Success Criteria
- [ ] Proposed TaskState fields and defaults documented.
- [ ] Persistence compatibility strategy documented.

## Dependencies
- Depends on: Step 2
- Blocks: Step 4

## Post-Work (FILLED DURING EXECUTION)
To be filled during execution.
