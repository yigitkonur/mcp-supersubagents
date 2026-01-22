# Persist Tasks by CWD (MD5 Hashed)

Make task state persistent per-workspace using MD5 hash of cwd as filename, stored in a centralized `~/.super-agents/` directory.

## Architecture

```
~/.super-agents/
├── {md5(cwd1)}.json    ← tasks for /Users/alice/project-a
├── {md5(cwd2)}.json    ← tasks for /Users/bob/project-b
└── ...
```

**Why MD5 hash?**
- Multiple users/processes can use same MCP server with different workspaces
- No filesystem path conflicts (slashes, special chars)
- Centralized storage — doesn't pollute workspace directories
- Deterministic: same cwd always maps to same file

## Implementation Steps

### 1. Create persistence service (`src/services/task-persistence.ts`)

```typescript
// Core functions
getStorageDir(): string           // ~/.super-agents/
getStoragePath(cwd: string): string  // ~/.super-agents/{md5(cwd)}.json
saveTasks(cwd: string, tasks: TaskState[]): void
loadTasks(cwd: string): TaskState[]
```

**Key behaviors:**
- Use `crypto.createHash('md5').update(cwd).digest('hex')` for hash
- Create `~/.super-agents/` directory if missing (use `os.homedir()`)
- Exclude non-serializable `process` field via custom serializer
- Atomic writes: write to `.tmp` file, then rename
- Mark previously-running tasks as `failed` with `"Server restarted"` error on load

### 2. Update `TaskManager` (`src/services/task-manager.ts`)

**New methods:**
- `setCwd(cwd: string)` — set active workspace, load existing tasks
- `persist()` — save current state to disk (debounced)

**Modify existing methods to trigger persistence:**
- `createTask()` → persist after
- `updateTask()` → persist after  
- `appendOutput()` → persist after (debounced more aggressively)
- `cancelTask()` → persist after

**Debounce strategy:**
- State changes: 100ms debounce
- Output appends: 1000ms debounce (high frequency)

### 3. Wire persistence in `index.ts`

```typescript
server.oninitialized = async () => {
  // ... existing root detection ...
  const cwd = clientContext.getDefaultCwd();
  taskManager.setCwd(cwd);  // loads tasks from ~/.super-agents/{md5(cwd)}.json
};
```

### 4. Update README.md

Document:
- Persistence location: `~/.super-agents/`
- Per-workspace isolation via MD5 hash
- Crash recovery behavior

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/services/task-persistence.ts` | **Create** — MD5 hashing, atomic JSON read/write |
| `src/services/task-manager.ts` | **Modify** — add `setCwd()`, `persist()`, debouncing |
| `src/index.ts` | **Modify** — call `taskManager.setCwd()` on init |
| `README.md` | **Modify** — document persistence |

## Edge Cases (All Covered)

| Scenario | Handling |
|----------|----------|
| **Orphaned running tasks** | Mark as `failed` with error `"Server restarted"` on load |
| **Corrupted JSON** | Log warning to stderr, start with empty task list |
| **Concurrent writes** | Atomic write (temp file + rename) prevents corruption |
| **Missing storage dir** | Create `~/.super-agents/` on first write |
| **Permission denied** | Log warning, continue in memory-only mode |
| **Disk full** | Catch write error, log warning, don't crash |
| **Very long output** | Already truncated by `MAX_OUTPUT_LINES` (2000) |
| **Multiple MCP instances** | Each instance uses same hash → shares state (feature) |
| **Task TTL cleanup** | Runs on loaded tasks too, cleans old completed tasks |

## Serialization

**Included fields:**
```typescript
{ id, status, prompt, output, pid, sessionId, startTime, endTime, 
  exitCode, error, cwd, model, autonomous, isResume }
```

**Excluded fields:**
- `process` — live process handle, not serializable

## Success Criteria

- [x] Tasks survive server restart
- [x] Each workspace has independent task history (via MD5)
- [x] Multiple users/workspaces supported concurrently  
- [x] No data loss on normal shutdown
- [x] Graceful degradation on disk errors
- [x] Atomic writes prevent corruption
