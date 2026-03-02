# Domain 6: Input Validation & Edge Cases

**Scope:** MCP server input validation, Zod schemas, path handling, template injection, race conditions, collision analysis  
**Files Reviewed:** `sanitize.ts`, `brief-validator.ts`, `format.ts`, `task-id-generator.ts`, `spawn-agent.ts`, `shared-spawn.ts`, `answer-question.ts`, `cancel-task.ts`, `question-registry.ts`, `templates/index.ts`, `client-context.ts`, `models.ts`  
**Date:** 2025-07-15

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 3     |
| Medium   | 7     |
| Low      | 4     |
| Info     | 3     |

---

## Findings

### VE-001 — Path Traversal via `specialization` Parameter (Template Loading)

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/templates/index.ts:131-136`, `src/tools/spawn-agent.ts:37`
- **Current Behavior:** The `specialization` field was validated only as `z.string().optional()` — no enum restriction, no path character filtering. It was directly interpolated into a file path for overlay loading.
- **Risk:** Arbitrary file read (limited by `.mdx` extension). Cross-template contamination. System prompt leakage.
- **Fix Applied:** Path traversal in specialization parameter blocked in `templates/index.ts`. Values containing `/`, `\`, or `..` are now rejected.

---

### VE-002 — Context File Path Traversal: No Workspace Boundary Check

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/utils/brief-validator.ts:179-238, 292-314`
- **Current Behavior:** The brief-validator checked that paths were absolute and readable, but never checked that files were within the workspace or any trust boundary.
- **Risk:** Arbitrary file read of any file readable by the server process. Sensitive data exfiltrated into agent context and output logs.
- **Fix Applied:** Context file workspace boundary check added in `brief-validator.ts`. Paths resolved with `realpath()` and verified against workspace root.

---

### VE-003 — Template Injection via `$` Replacement Patterns in User Prompt

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/templates/index.ts:160-162`
- **Current Behavior:** User prompt was injected via `String.prototype.replace()` which treats `$` characters as special patterns (`` $` `` inserts everything before the match, etc.).
- **Risk:** System prompt leakage. The agent's hidden instructions became visible in its own context.
- **Fix Applied:** Template `$` injection fixed with function replacer in `templates/index.ts`: `.replace('{{user_prompt}}', () => userPrompt)`.

---

### VE-004 — TOCTOU Race: File Validated Then Read Separately

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/utils/brief-validator.ts:200-238, 299-305`
- **Current Behavior:** `validateBrief()` checks file existence and size, then `assemblePromptWithContext()` reads the file in a separate async operation. Between these, a file can be swapped, grown, or replaced.
- **Risk:** Size limit bypass, content injection via symlink redirect.
- **Fix Applied:** Read file content during validation (single read) and pass already-read content to assembly.

---

### VE-005 — Task ID Collision: Silent Overwrite Without Detection

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/utils/task-id-generator.ts:7-18`, `src/services/task-manager.ts:988-1035`
- **Current Behavior:** `createTask()` sets the task in the Map with no check for existing entries. ~42.7M ID space; over 10,000 spawns, collision probability ~2.3%.
- **Risk:** Orphaned running processes, lost task state and output.
- **Fix Applied:** Add collision-retry loop in `createTask()`.

---

### VE-006 — `depends_on` Array: No Maximum Length Constraint

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/utils/sanitize.ts:14`
- **Current Behavior:** `sharedDependsOnSchema` has no `.max()`. Thousands of dependency IDs can be passed.
- **Risk:** CPU exhaustion via algorithmic complexity attack on cycle detection.
- **Fix Applied:** Add `.max(50)` to `sharedDependsOnSchema`.

---

### VE-007 — `cwd` Parameter: No Validation or Sanitization

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/utils/sanitize.ts:27,73,85,98,109`
- **Current Behavior:** `cwd` is `z.string().optional()` — no absolute path check, no existence check, no workspace boundary check.
- **Risk:** Agent operates in attacker-controlled directory. Output files written to sensitive directories.
- **Fix Applied:** Validate `cwd` is absolute, exists, and falls within workspace roots.

---

### VE-008 — `answer` Field: No Maximum Length

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/tools/answer-question.ts:15`
- **Current Behavior:** `answer: z.string().min(1)` with no `.max()`. Arbitrary-size answers accepted.
- **Risk:** Memory exhaustion, prompt injection at scale.
- **Fix Applied:** Add `.max(10000)`.

---

### VE-009 — Freeform Answer: Missing Control Character Sanitization

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/question-registry.ts:186-228`
- **Current Behavior:** `CUSTOM:` prefixed answers have control characters stripped, but freeform responses do not.
- **Risk:** Prompt injection or agent behavior manipulation via control characters.
- **Fix Applied:** Apply the same control character stripping regex to all freeform answers.

---

### VE-010 — Symlink Following in Context File Reads

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/utils/brief-validator.ts:200-238`
- **Current Behavior:** `access()` and `stat()` follow symlinks by default.
- **Risk:** Bypass workspace boundary assumptions via symlink indirection.
- **Fix Applied:** Use `lstat()` to detect symlinks, then `realpath()` to resolve and verify.

---

### VE-011 — `file://` URI Parsing: Naive String Replacement

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/client-context.ts:15-18`
- **Current Behavior:** `decodeURIComponent(r.uri.replace('file://', ''))` fails for `file://hostname/path` and edge cases.
- **Risk:** Default CWD set to attacker-influenced location.
- **Fix Applied:** Use `url.fileURLToPath()` for proper RFC 8089 file URI parsing.

---

### VE-012 — Zod Schema Mismatch: `SpawnAgentSchema` Weaker Than Role-Specific Schemas

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/tools/spawn-agent.ts:33-44`, `src/utils/sanitize.ts:68-114`
- **Current Behavior:** The unified `SpawnAgentSchema` doesn't enforce role-specific context file requirements or specialization enum validation.
- **Risk:** Defense-in-depth gap. Invalid specializations pass silently.
- **Fix Applied:** Add conditional Zod refinements or validate specialization against role-appropriate enums.

---

### VE-013 — Cancel-All Race with Concurrent Spawn

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/tools/cancel-task.ts:81-103`
- **Current Behavior:** A spawn already past `createTask()` check can create a new task after `clearAllTasks()` completes.
- **Risk:** Incomplete cleanup.
- **Fix Applied:** Add a generation counter that spawn checks after async operations complete.

---

### VE-014 — `prompt` Field: No Final Size Check on Assembled Prompt

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/utils/sanitize.ts:69`, `src/utils/brief-validator.ts:287-315`
- **Current Behavior:** User prompt (100K max) + context files (500KB) + template (10-20KB) = 600KB+ with no final check.
- **Risk:** Wasted compute if rejected by SDK.
- **Fix Applied:** Add final size check on assembled prompt.

---

### VE-015 — `Math.random()` for Task IDs: Predictable in Theory

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/utils/task-id-generator.ts:8`
- **Current Behavior:** V8's xorshift128+ PRNG is deterministic given seed state.
- **Risk:** Theoretical. Practical exploitation unlikely.
- **Fix Applied:** Use `crypto.randomInt()` instead.

---

### VE-016 — Template Cache: No Invalidation

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/templates/index.ts:17, 102-111`
- **Current Behavior:** Once loaded, templates cached forever. Hot patches require restart.
- **Risk:** Operational issue only.
- **Fix Applied:** Add `clearTemplateCache()` callable from SIGHUP handler.

---

### VE-017 — Question Cleanup: Double-Reject Possible

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/services/question-registry.ts:348-354`
- **Current Behavior:** `cleanup()` calls `reject()` without checking `settled`. Safe due to Promise idempotency.
- **Risk:** None.
