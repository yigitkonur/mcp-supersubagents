# Domain 5: Persistence & Recovery

**Scope:** Disk persistence layer  
**Files Audited:** `task-persistence.ts`, `output-file.ts`, `task-manager.ts`, `types.ts`, `config/timeouts.ts`, `index.ts`  
**Date:** 2025-07-13

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 2     |
| Medium   | 4     |
| Low      | 8     |
| Info     | 2     |

---

## Findings

### PR-001 — Debounced Persistence Creates Data Loss Window on Crash

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:731-756, 1094-1102`
- **Current Behavior:** Non-terminal state transitions used `schedulePersist('state')` with a 100ms debounce. If the process crashed within this window, the RUNNING state was never written to disk.
- **Risk:** Orphaned SDK sessions with no record of RUNNING state. On restart, tasks seen as PENDING and marked FAILED.
- **Fix Applied:** Immediate persist added for PENDING→RUNNING transitions in `task-manager.ts`.

---

### PR-002 — `clearAllTasks()` Does Not Persist Empty State

- **Severity:** High
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:642-678`
- **Current Behavior:** `clearAllTasks()` cleared the in-memory map but never called `schedulePersist()` or `persistNow()`. On restart, old task data was resurrected.
- **Risk:** Zombie tasks reappeared after restart, potentially triggering unwanted retries.
- **Fix Applied:** `clearAllTasks` now persists empty state in `task-manager.ts`.

---

### PR-003 — `persistNow()` Failure During Shutdown Is Silent and Non-Retriable

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:1292-1329`
- **Current Behavior:** If `persistNow()` fails during shutdown, `process.exit()` is called immediately after. The final state is never persisted.
- **Risk:** Tasks that were RUNNING at shutdown time persist as RUNNING (stale), causing incorrect recovery on next startup.
- **Fix Applied:** Retry `persistNow()` once on failure during shutdown.

---

### PR-004 — TOCTOU Race in Symlink Check for Storage Directory

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:43-63`
- **Current Behavior:** `mkdir` creates the directory, then `lstat` checks for symlinks. An attacker racing between them could replace the directory.
- **Risk:** Arbitrary file overwrite on the filesystem.
- **Fix Applied:** Use `O_NOFOLLOW` when opening files or verify directory ownership.

---

### PR-012 — Recovery Marks WAITING Tasks as FAILED Even If Dependencies Are Satisfied

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:101-123`
- **Current Behavior:** On restart, all WAITING tasks are marked FAILED regardless of dependency state. Some may have all deps already COMPLETED.
- **Risk:** Valid, ready-to-execute tasks unnecessarily failed.
- **Fix Applied:** Check `areDependenciesSatisfied()` for WAITING tasks; if all deps COMPLETED, transition to PENDING instead.

---

### PR-014 — Broken Pipe During Shutdown May Skip Final Persist

- **Severity:** Medium
- **Status:** ✅ Fixed
- **Location:** `src/index.ts:90-96, 108-118`
- **Current Behavior:** The force-exit timer (15s) can fire before `persistNow()` completes if SDK cleanup takes too long.
- **Risk:** All unsaved state changes lost.
- **Fix Applied:** Prioritize `persistNow()` earlier in shutdown sequence (before SDK cleanup).

---

### PR-005 — Output Files Have No Durability Guarantee (No fsync)

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/output-file.ts:165, 197-205`
- **Current Behavior:** `appendToOutputFile()` calls `handle.write()` without `fsync`/`datasync`. Data sits in kernel page cache.
- **Risk:** Recent output lines lost on OS crash.
- **Fix Applied:** Call `handle.datasync()` in `finalizeOutputFile()` before close.

---

### PR-006 — Stale Handle Cleanup Can Close Handles for Active Tasks

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/output-file.ts:218-245`
- **Current Behavior:** Handles opened more than 5 minutes ago are closed regardless of whether the task is still actively writing.
- **Risk:** Brief window where concurrent writes race on re-open.
- **Fix Applied:** Track last-write time per handle, not just open time.

---

### PR-007 — Dirty Check Uses MD5 — Documentation Says "length + charCode hash"

- **Severity:** Low (Info)
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:144`, `CLAUDE.md`
- **Current Behavior:** Implementation uses MD5 (better), documentation says "length + charCode hash."
- **Risk:** None. Code is better than documented.
- **Fix Applied:** Update CLAUDE.md to accurately describe the MD5-based dirty check.

---

### PR-008 — No Protection Against Future Persistence Format Versions

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:215-229`
- **Current Behavior:** Only handles v1 and v2. A v3 format would be silently misinterpreted.
- **Risk:** Task state corruption on downgrade.
- **Fix Applied:** Check `parsed.version` explicitly and reject files with `version > 2`.

---

### PR-009 — `createOutputFile()` and `appendToOutputFile()` Can Race

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-manager.ts:1011-1012`, `src/services/output-file.ts:116-138`
- **Current Behavior:** Fire-and-forget `createOutputFile` may run after `appendToOutputFile`, causing missing header.
- **Risk:** Cosmetic — missing header in output file.

---

### PR-010 — Persistence File Corruption if JSON Serialization Throws

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:141`
- **Current Behavior:** If `JSON.stringify` throws, the persist silently fails. If the error is persistent, all future persists fail.
- **Risk:** Extended data-loss window.
- **Fix Applied:** Wrap individual task serialization and exclude problematic tasks.

---

### PR-011 — `writeChain` Grows Unboundedly on High Write Frequency

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:13, 132`
- **Current Behavior:** Rapid state changes create long promise chains with accumulated closures.
- **Risk:** Potential memory pressure in extreme cases.
- **Fix Applied:** Add coalescing: if a write is pending, mark dirty and re-run after current write completes.

---

### PR-013 — `lastSerializedHashes` Never Evicted for Old CWDs

- **Severity:** Low
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:16`
- **Current Behavior:** One entry per unique file path, never removed.
- **Risk:** Very minor memory leak.

---

### PR-015 — `ensureStorageDir` Cache Invalidation on Error Is Overly Broad

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/services/task-persistence.ts:161`
- **Current Behavior:** Any write failure resets `storageDirExists = false`, forcing unnecessary directory checks.
- **Risk:** Minor performance impact.

---

### PR-016 — Output File `knownDirs` Cache Cleared Atomically at 500 Entries

- **Severity:** Info
- **Status:** ✅ Fixed
- **Location:** `src/services/output-file.ts:101-103`
- **Current Behavior:** Entire set cleared at once, causing transient performance degradation.
- **Risk:** Unnecessary syscalls after cache clear.
- **Fix Applied:** Use gradual eviction instead of full clear.
