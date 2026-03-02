# Domain 05: Persistence & Recovery

## Persistence Model

| Data | Location | Trigger | Debounce |
|------|----------|---------|----------|
| Task state | `~/.super-agents/{md5(cwd)}.json` | Status change, task create, cleanup | 100ms (state) / 1000ms (output) |
| Task state (terminal) | Same | Terminal status reached | Immediate (persistNow) |
| Output logs | `{cwd}/.super-agents/{taskId}.output` | appendOutput/appendOutputFileOnly | Per-write via enqueueWrite |
| Cooldowns | Embedded in task state JSON | With task state | Same as task state |

## Atomic Write Implementation

```
saveTasks(filePath, data):
  1. MD5 dirty check → skip if unchanged
  2. ensureStorageDir (with symlink protection)
  3. Create temp file: {filePath}.{random}.tmp
  4. fd.writeFile(data, 'utf-8')  ← FIXED: was fd.write (partial write risk)
  5. fd.datasync()
  6. fd.close()
  7. fs.rename(temp, final)  ← POSIX atomic on local FS
  8. Update lastSerializedHashes
  
  On ANY error:
  9. Best-effort unlink temp file
  10. Log error, resolve(false)
```

## Data Loss Windows

| Scenario | Max Window | Recovery |
|----------|-----------|---------|
| Terminal status (COMPLETED/FAILED) | ~10-60ms (fsync latency) | RUNNING on disk → recovered as FAILED |
| Non-terminal status change | ~100ms (debounce) | Recovered as FAILED (correct) |
| Output lines (in-memory) | ~1000ms (debounce) | Last lines lost |
| Output file content | Unbounded (no fsync) | Last few KB lost |
| New task creation | ~100ms | Entire task lost |
| clearAllTasks | 0ms | **FIXED**: now calls persistNow immediately |

## Findings

| # | Severity | File | Finding | Status |
|---|----------|------|---------|--------|
| F-1 | **HIGH** | task-manager.ts | persistNow() fire-and-forget for terminal transitions | **FIXED** (catch logs) |
| F-2 | **HIGH** | task-persistence.ts | No backup of corrupted persistence file before returning empty | **FIXED** |
| F-3 | **HIGH** | task-id-generator.ts | ~196K ID space with no collision check | **FIXED** |
| F-4 | MEDIUM | task-manager.ts | clearAllTasks() doesn't persist | **FIXED** |
| F-5 | MEDIUM | task-persistence.ts | fd.write() partial write unchecked | **FIXED** (fd.writeFile) |
| F-6 | MEDIUM | task-persistence.ts | No cross-process file locking | Documented |
| F-7 | MEDIUM | task-manager.ts | RATE_LIMITED thundering herd on restart | **FIXED** (jitter) |
| F-8 | LOW | task-persistence.ts | rename() not atomic on NFS/Docker volumes | — |
| F-9 | LOW | output-file.ts | No fsync on output appends | — |
| F-10 | LOW | task-persistence.ts | TOCTOU between mkdir and symlink lstat | — |
| F-11 | LOW | output-file.ts | closeStaleHandles can race with enqueueWrite | — |
| F-12 | INFO | task-manager.ts | Dual debounce intervals (100ms/1000ms) rarely differ in practice | — |

## Recovery Behavior

| Pre-crash State | On-disk State | Recovery Action |
|----------------|--------------|-----------------|
| RUNNING | RUNNING | → FAILED ("orphaned") |
| PENDING | PENDING | → FAILED ("orphaned") |
| WAITING | WAITING | → FAILED ("deps not satisfiable") |
| RATE_LIMITED | RATE_LIMITED | Preserved + jittered retry time |
| COMPLETED | COMPLETED | Unchanged |
| FAILED | FAILED | Unchanged |
| CANCELLED | CANCELLED | Unchanged |
| TIMED_OUT | TIMED_OUT | Unchanged |
| RUNNING (not yet persisted) | Not on disk | Task lost entirely |

## Corruption Scenarios

| Failure Mode | Impact | Mitigation |
|-------------|--------|-----------|
| SIGKILL mid-temp-write | Orphaned .tmp; main file intact | loadTasks cleans orphans |
| SIGKILL after rename | File consistent (fsynced) | Clean recovery |
| Disk full during write | Error logged; old file intact | Graceful |
| JSON parse error | **FIXED**: Corrupt file backed up to `.corrupt.{timestamp}` | Manual recovery possible |
| File >10MB | **FIXED**: Backed up before returning empty | Manual recovery possible |
| Two servers same cwd | Last-writer-wins; no locking | Documented limitation |
