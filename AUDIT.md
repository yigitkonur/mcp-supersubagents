# MCP-SuperSubagents — Realtime-Agent Audit Report

**Repository:** `/Users/yigitkonur/dev-test/mcp-supersubagents`  
**Audit wave:** Wave-1 findings synthesis + line-by-line verification  
**Primary files verified:** `sdk-session-adapter.ts`, `output-file.ts`, `task-manager.ts`, `claude-code-runner.ts`, `index.ts`, `session-snapshot.ts`, `task-persistence.ts`

---

## How It Works

### a) Copilot SDK Event → SessionEvent Handler → TaskState → MCP Resource

The SDK emits `SessionEvent` objects on a session-level subscription. The full pipeline:

```
SDK emits SessionEvent
  ↓
sdkSessionAdapter.bind() registers:  newSession.on((event) => handleEvent(taskId, event, binding))
  ↓
handleEvent() [sdk-session-adapter.ts:250]
  → Guard 1: binding.isUnbound → return immediately (prevents stale events after rotation)
  → Guard 2: binding.isPaused && event.type !== 'session.error' → return (during rotation)
  → switch(event.type) dispatch [line 267]
  ↓
Specific handler (e.g. handleTurnStart, handleMessageDelta, handleAssistantMessage, handleToolComplete)
  ↓
taskManager.appendOutput(taskId, line)    — both in-memory AND .output file
taskManager.appendOutputFileOnly(taskId, line)  — .output file ONLY
  ↓
MCP resource read (task:///{id}): returns task.output[].slice(-50) after filterOutputForResource()
```

**Fields read per key event:**

| SDK Event | Field(s) Read | Destination |
|---|---|---|
| `session.start` | `event.data.sessionId` | `binding.sessionId` |
| `assistant.message_delta` | `event.data.deltaContent` | pushed to `binding.outputBuffer[]` |
| `assistant.turn_end` | (flushes buffer) | `outputBuffer.join('')` → `appendOutput` |
| `assistant.message` | `event.data.content` or buffer fallback | `appendOutput` (in-memory + file) |
| `assistant.reasoning_delta` | `event.data.deltaContent` | `binding.reasoningBuffer[]` → file-only |
| `assistant.usage` | `event.data.inputTokens`, `outputTokens` | `binding.totalTokens` |
| `tool.execution_start` | `event.data.toolName`, `toolCallId`, `mcpServerName` | file-only `[tool] Starting: …` |
| `tool.execution_complete` | `event.data.success`, `error`, `toolCallId` | in-memory if >100ms; file-only if <100ms |
| `session.shutdown` | `event.data.shutdownType`, `errorReason` | → FAILED or cleanup only |
| `session.idle` | (no fields) | → COMPLETED (when `!binding.isCompleted`) |
| `session.compaction_complete` | `event.data.tokensRemoved`, `success` | `appendOutput` |

**Two-tier split summary:**
- `appendOutput` → `task.output[]` **AND** `.super-agents/{taskId}.output` file  
- `appendOutputFileOnly` → `.output` file **ONLY** (reasoning, tool-starts, fast completions, user message previews, turn-ended markers)

---

### b) Two-Tier Output: `.output` File vs `task.output[]` vs MCP Resources

A realistic 10-line `.output` file mid-run (with annotations):

```
# Task: brave-fox-42
# Started: 2024-01-15T10:30:00.000Z
# Working directory: /Users/dev/project
────────────────────────────────────────────────────────────
[session] Session started                          ← appendOutput (in-memory + file)
[user] Implement auth module with JWT...           ← appendOutputFileOnly (FILE ONLY)
[tool] Starting: read_file (MCP: filesystem)       ← appendOutputFileOnly (FILE ONLY)
[reasoning] I should read existing code first...   ← appendOutputFileOnly (FILE ONLY)
[tool] Completed: read_file (237ms)                ← appendOutput (>100ms → in-memory + file)
[tool] Starting: grep_files                        ← appendOutputFileOnly (FILE ONLY)
[tool] Completed: grep_files (45ms)                ← appendOutputFileOnly (<100ms → FILE ONLY)
I'll implement JWT using the patterns I found...   ← appendOutput (in-memory + file)
[assistant] Turn ended: msg_abc123                 ← appendOutputFileOnly (FILE ONLY)
[tool] Completed: write_file (156ms)               ← appendOutput (in-memory + file)
```

**What `task:///id` returns** (after `filterOutputForResource` + last 50 lines):
```
[session] Session started
[tool] Completed: read_file (237ms)
I'll implement JWT using the patterns I found...
[tool] Completed: write_file (156ms)
```

The `grep_files` completion at 45ms is **invisible** in `task:///id`—it went to `appendOutputFileOnly`. This is finding **B6**.

---

### c) Streaming Model: Token-by-Token or Summarized?

**Copilot path — buffered, one element per turn:**  
`assistant.message_delta` events accumulate individual delta tokens into `binding.outputBuffer[]`. The buffer is **not forwarded** to `task.output[]` until `assistant.turn_end` fires (or the buffer exceeds `MAX_OUTPUT_BUFFER`). At flush, `outputBuffer.join('')` produces a **single string** pushed as **one element** into `task.output[]`.

Effect: `task.output[]` has one element per assistant turn, not one per token. The 2000-element cap fills from turn count × tool completions (>100ms), not individual tokens. A typical 30-turn task with 20 tool calls uses ~50 elements total.

**Claude fallback path — per-delta forwarding:**  
`text-delta` parts call `taskManager.appendOutput(taskId, String((part as any).delta))` directly (line 308). Each token chunk is its own `appendOutput` call → its own element in `task.output[]`. A single 2000-token response may produce hundreds of elements, hitting the 2000-element cap in ~5-10 assistant turns.

**Context pressure:** Copilot tasks can sustain 40+ turns before cap eviction. Claude fallback tasks hit eviction after ~5 turns if responses are verbose. Once eviction starts, early turns vanish from `task:///id/session` permanently.

---

### d) Claude Fallback Path

**Stream part → output line mapping:**

| Stream Part Type | Handler | Output Destination |
|---|---|---|
| `text-start` | emits `\n[Assistant Turn N]\n` | `appendOutput` (1 element) |
| `text-delta` | emits each delta chunk | `appendOutput` (1 element per chunk) |
| `text-end` | clears `inTextBlock` flag | (no output) |
| `reasoning-delta` | `[reasoning] {part.delta}` | `appendOutputFileOnly` |
| `tool-input-start` | `[tool] Starting: {toolName}` | `appendOutput` |
| `tool-result` | `[tool] Completed/Failed: {name} ({ms}ms)` | `appendOutput` |
| `finish` | updates token totals; sets resultError if `finishReason.unified==='error'` | (metadata only) |
| `error` | `[error] {message}` | `appendOutput` |
| `tool-approval-request` | **unhandled** — falls to `default` | (silently dropped — **C5**) |

**Structural differences from Copilot path:**

| Dimension | Copilot | Claude Fallback |
|---|---|---|
| Turn marker format | (varies by SDK version) | `\n[Assistant Turn N]\n` |
| Output granularity | 1 element per turn (buffered) | 1 element per text-delta token |
| Tool-start visibility | File-only | In-memory (`appendOutput`) |
| Tool-result for fast tools | File-only if <100ms | Always in-memory |
| Reasoning | File-only via reasoning buffer | File-only via `appendOutputFileOnly` |

**Context surviving snapshot handoff (`buildHandoffPrompt`):**  
- ✅ Survives: `task.prompt` (original, may truncate at 20,000 chars — **C2**), recent `user.message`/`assistant.message` text pairs parsed from `.output` file  
- ❌ Doesn't survive: `tool.call`, `tool.result` events (silently dropped in `pairsFromSessionEvents` — **C4**), intermediate reasoning, in-flight output buffer state, quota/rotation metadata

---

### e) File Write Mechanics

**One write per line, serialized per task:**  
Every `appendToOutputFile(cwd, taskId, line)` call enqueues exactly one `handle.write(line + '\n')` via `enqueueWrite`. Writes are serialized per `key = "${cwd}:${taskId}"` through `writeQueues`—no batching across tasks, no batching within a task's concurrent calls.

**Exact newline insertion points:**  
- `output-file.ts:165`: `await handle.write(line + '\n')` — adds one trailing `\n`  
- `claude-code-runner.ts:302`: the `line` argument is `\n[Assistant Turn N]\n` — contains prefix `\n` and internal `\n`  
- Net result in file: prefix `\n` + content + internal `\n` + trailing `\n` = **3 newlines total** around the marker

**Sample with double-newline bug (B3):**
```
[tool] Completed: read_file (234ms)
                              ← blank line  (from the \n prefix in the string literal)
[Assistant Turn 3]
                              ← blank line  (from the \n suffix in string + write's own \n)
I'll now write the authentication module...
```

---

### f) `task:///all` vs `system:///status` vs `.output` File

| Resource | Contents | Freshness Trigger | Max Size | Key Limitation |
|---|---|---|---|---|
| `task:///all` | Task list: status, stats, pending questions | Every status change (un-debounced) | 100 tasks × stats | 200K line iteration per read (**D1**); pendingQuestion verbatim (**D9**) |
| `task:///{id}` | Status + last 50 filtered output lines | Output: debounced 1s; Status: immediate | ~50 lines of task.output | Misses file-only events; loses early turns after 2000-line trim |
| `task:///{id}/session` | Execution log parsed from task.output[] | Same as task:///{id} | 2000 lines | Depends on `[assistant] Turn ended` markers which filterOutputForResource strips (**D3**) |
| `system:///status` | In-memory counters: token stats, task counts | Status changes | Small JSON | No live SDK probe; stalled sessions appear healthy (**D2**) |
| `.super-agents/{id}.output` | Everything: reasoning, all tool events, user previews | Continuous async writes | Unbounded | Finalization barriers can be cleared by stale-handle cleanup (**B1/B2**) |

**When they diverge:**
- A fast grep tool (<100ms) appears in `.output` but not in `task:///id`  
- After 2000-line eviction, early turns vanish from `task:///id/session` but remain in `.output`  
- A stalled session appears `RUNNING` in `system:///status` with no warning signal  
- During token rotation, status-change notifications fire immediately (triggering 200K-line task:///all scan) while output notifications wait 1s (**D4**)

---

### g) SDK Breadcrumb Safety Across Rotation and Copilot→Claude Switch

**Copilot→Copilot rotation (`rebindWithNewSession`, lines 718–744):**

| Field | Preserved? | Notes |
|---|---|---|
| `turnCount` | ✅ | Accurate cumulative count |
| `totalTokens` | ✅ | Accumulates across sessions |
| `toolMetrics` | ✅ | Full Map preserved |
| `toolStartTimes` | ✅ | In-flight tool tracked |
| `toolCallIdToName` | ✅ | Accurate completion matching |
| `outputBuffer` | ✅ (by reference — **A5**) | Late events from old session can corrupt |
| `reasoningBuffer` | ✅ (by reference — **A5**) | Same race risk |
| `rotationAttempts` | ✅ | Counts against limit |
| `isPaused` | ❌ reset to `false` | Correct |
| `isCompleted` | ❌ reset to `false` | Correct |
| `sessionId` | ❌ new value | `sessionOwners` map updated |

After rotation, the new session receives the **full original task prompt** as a handoff message (line 770), not just a "continue" — causing the agent to restart work from scratch regardless of what the old session completed.

**Copilot→Claude switch (`buildHandoffPrompt`, session-snapshot.ts:159–204):**

| State | Survives? | Notes |
|---|---|---|
| Original `task.prompt` | ✅ (with truncation risk at 20K chars — **C2**) | Hard mid-word slice |
| Recent user/assistant message text | ✅ | Parsed from `.output` file |
| Tool call events | ❌ | Silently dropped (**C4**) |
| Tool result events | ❌ | Silently dropped (**C4**) |
| Reasoning content | ❌ | Not in `.output` user/assistant pairs |
| Token counts / quotas | ❌ | Not transmitted to Claude |
| Rotation attempt count | ❌ | Claude starts fresh |

---

## Findings

> Sorted HIGH → MED → LOW. All line numbers verified against source unless marked UNVERIFIED.

| # | Severity | File | Lines | Mistake | Impact | Evidence |
|---|----------|------|-------|---------|--------|----------|
| 1 | **HIGH** | `output-file.ts` | 230–232 | `closeStaleHandles` unconditionally calls `finalizedKeys.delete(key)` for every stale handle, including completed tasks | Finalization barrier removed; subsequent `appendToOutputFile` calls pass the guard and write after the footer → structurally corrupt output files | `openHandles.delete(key); handleOpenTimes.delete(key); finalizedKeys.delete(key)` — no check whether task was completed |
| 2 | **HIGH** | `output-file.ts` | 236–238 | `finalizedKeys.clear()` fires unconditionally when `finalizedKeys.size > 1000` | In a server with >1000 lifetime tasks (~10 full-capacity cycles), all finalization barriers are wiped simultaneously; all pending fire-and-forget appends proceed past the guard | `if (finalizedKeys.size > 1000) { finalizedKeys.clear(); }` |
| 3 | **HIGH** | `sdk-session-adapter.ts` | 262–264, 1000–1028 | `binding.isPaused` guard (set during proactive rotation at quota <1%) silently drops `session.idle`; new session then re-sends the full original task prompt to a fresh session | Complete task re-execution from scratch, double-billing compute and side effects for any task that triggered proactive rotation near completion | `if (binding.isPaused && event.type !== 'session.error') return;` at line 263; handoff sends `currentTask.prompt` verbatim at line 770 |
| 4 | **HIGH** | `sdk-session-adapter.ts` | 1265–1280 | `session.shutdown` with `shutdownType === 'routine'` and `!binding.isCompleted` hits no branch — neither COMPLETED nor FAILED is set | Task permanently stuck in RUNNING status until TTL eviction (1hr); no output finalization, stall warning fires after 5min | `if (shutdownType === 'error') { FAILED } else if (binding.isCompleted) { unbind }` — no `else` for routine+incomplete |
| 5 | **HIGH** | `session-snapshot.ts` | 93–131, 199–201 | `pairsFromSessionEvents` handles only `user.message` and `assistant.message`; all `tool.call` and `tool.result` events silently dropped from snapshot. Additionally, snapshot hard-slices mid-word at 20,000 chars | Claude fallback agent has zero visibility of tools already invoked; re-executes all completed tool calls. Truncated prompt may provide syntactically broken task description | `for (const event of events)` loop handles only two `event.type` values; `snapshot.slice(0, MAX_TOTAL_LENGTH - 100)` at line 201 |
| 6 | **HIGH** | `claude-code-runner.ts`, `process-registry.ts` | 548–568 | `cancelTask` calls `abortController.abort()` without a reason string; `claude-code-runner.ts` checks `reason.toLowerCase().includes('cancel')` — empty string → false → task marked `TIMED_OUT` instead of `CANCELLED` | Every user-initiated cancel of a Claude fallback task has wrong terminal status; MCP clients and orchestrators misread intentional cancels as timeouts | `if (reason.toLowerCase().includes('cancel')) { CANCELLED } else { TIMED_OUT }` at lines 550–567; abort called with no reason |
| 7 | **MED** | `sdk-session-adapter.ts` | 718–724 | `rebindWithNewSession` copies `outputBuffer` and `reasoningBuffer` by reference from old binding to new binding; fire-and-forget `destroySession` (line 705) creates a window where late events from old session write to the shared buffer | Buffer corruption possible on slow TCP teardown; partial LLM token from old session prepended to new session's response | `outputBuffer: oldBinding.outputBuffer, reasoningBuffer: oldBinding.reasoningBuffer` — same Array object reference |
| 8 | **MED** | `task-manager.ts` | 1153–1163 | `task.output.push(line)` fires `this.outputCallback?.(id, line)` at 2001 elements **before** `splice(0, excess)` executes; callback (and MCP notification) sees the element that will be immediately removed | MCP notification consumers briefly see content that is no longer in the resource; orchestrators polling `task:///id` may act on ephemeral content | `task.output.push(line); this.outputCallback?.(…); if (task.output.length > MAX) { task.output.splice(0, …) }` |
| 9 | **MED** | `index.ts` | 580–587 | `task:///all` handler calls `extractMessageStats(task.output)` for **every** task; worst case = 100 tasks × 2000 lines = 200,000 synchronous iterations per request, blocking the event loop | Every `task:///all` poll or subscription refresh stalls all concurrent MCP responses; cascades with un-debounced status-change notifications (finding #10) | `allTasks.map(task => { const stats = extractMessageStats(task.output); ... })` at lines 585–586 |
| 10 | **MED** | `index.ts` | 159–192, 195–226 | Output notifications debounced to 1/sec per task (line 189 `setTimeout(…, 1000)`); status-change notifications are **not debounced** and call `sendResourceUpdated({ uri: 'task:///all' })` immediately on every transition | Every token rotation (which fires multiple status transitions) immediately triggers a `task:///all` read of 200K lines; CPU spike cascade during high-rotation periods | `taskManager.onStatusChange(…)` directly calls `server.sendResourceUpdated` with no debounce at lines 220–222 |
| 11 | **MED** | `output-file.ts` | 196–213 | `finalizeOutputFile` uses `enqueueWrite`; `shutdown()` at close calls `closeAllOutputHandles()` which clears `writeQueues` (line 257) before queued finalize writes execute | Output files missing `# Completed` footer under load or on `SIGKILL`; incomplete files indistinguishable from mid-run files | `writeQueues.clear()` in `closeAllOutputHandles` at line 257 races fire-and-forget `finalizeOutputFile` calls |
| 12 | **MED** | `sdk-session-adapter.ts` | 1113–1118 | `tool.execution_complete` sends fast tools (<100ms) to `appendOutputFileOnly`; grep, cat, head, and most read-only tools execute in <100ms | Tool completions invisible in `task:///id` resource view; orchestrators polling the resource see no evidence of tool execution for the most common tools | `if (duration < 100) { taskManager.appendOutputFileOnly(…) }` at lines 1114–1115 |
| 13 | **MED** | `claude-code-runner.ts` | 296–304, 427–429 | `text-start` increments `turnCount` on every new text block; structured JSON output or multi-block responses emit a second `[Assistant Turn N]` marker and inflate `turnCount`; `error` part sets `resultError` but `finish` part (lines 421–422) overwrites it with a generic "Claude stream ended with error" string | Inflated turn counts, mismatched execution log; more specific error discarded, harder debugging | `if (!inTextBlock) { turnCount += 1 }` at line 301; `resultError = \`Claude stream ended with error (…)\`` at line 422 |
| 14 | **MED** | `task-persistence.ts` | 168 | `quickHash` samples only 4 data points: string length + `charCodeAt(0)` + `charCodeAt(length-1)` + `charCodeAt(length>>1)` — weak fingerprint | Two different serialized states with the same length and same characters at those 3 positions skip the disk write; task state lost on crash | `\`${data.length}:${data.charCodeAt(0)}:${data.charCodeAt(data.length-1)}:${data.charCodeAt(data.length>>1)}\`` |
| 15 | **MED** | `claude-code-runner.ts` | 451–474 | `tool-approval-request` stream part type is not handled in switch and doesn't match the `tool-error` default guard; falls through silently | Tools never execute if permission mode is not `bypassPermissions`; task appears to hang | No `case 'tool-approval-request'` branch; `default:` only handles `tool-error` by type string check |
| 16 | **LOW** | `index.ts` | 362–364 | `GetTaskPayload` handler returns `isError: task.status !== TaskStatus.COMPLETED`; cancelled tasks return `isError: true` | MCP clients trigger error-handling flows for intentional user cancellations | `isError: task.status !== TaskStatus.COMPLETED` at line 364 covers CANCELLED, TIMED_OUT equally |
| 17 | **LOW** | `task-persistence.ts` | 13, 16 | `writeChain` and `lastSerializedHash` are module-level singletons, not per-`cwd`; in a multi-`cwd` scenario the second cwd's state is hashed against the first cwd's last serialized data | State silently skipped for all cwds after the first in the write chain | `let writeChain = Promise.resolve()` and `let lastSerializedHash = ''` at module scope lines 13 and 16 |
| 18 | **LOW** | `task-persistence.ts` | 101–147 | Pass 2 of `recoverOrphanedTasks` guards on `task.status !== TaskStatus.WAITING`; Pass 1 converts all WAITING tasks to FAILED (line 107), so Pass 2's WAITING guard is never true | Dead code creates false confidence in two-pass recovery; any future change to Pass 1 logic may silently break Pass 2 | Pass 1 at line 107: `TaskStatus.WAITING → FAILED`; Pass 2 at line 127: `if (task.status !== TaskStatus.WAITING …) return task` — always true after Pass 1 |

---

### UNVERIFIED Findings

The following Wave-1 findings could not be confirmed from the lines reviewed in this audit. They are retained for completeness:

| # | Severity | Claim | Reason Not Verified |
|---|----------|-------|-------------------|
| A4 | MED | Dual 429 detection — spawner uses fragile regex on error message string rather than `event.data.statusCode` | `sdk-spawner.ts:520–530` not read |
| A6 | MED | PTY FD count via `(entry.client as any).cliProcess?.pid` — silent failure if SDK renames field | `sdk-client-manager.ts:712–730` not read |
| A7 | MED | TCP mode with OS-assigned port, no `EADDRINUSE` handling | `sdk-client-manager.ts:307–324` not read |
| A8 | MED | PTY recycle blocked by `entry.sessions.size === 0` guard during long-running tasks | `sdk-client-manager.ts:702–743` not read |
| A10 | LOW | `onErrorOccurred` in `session-hooks.ts` fires `appendOutput` + `updateTask` for same error as `handleSessionError` | `session-hooks.ts:103–145` not read |
| D3 | MED | `filterOutputForResource` strips `[assistant] Turn ended` markers that `parseOutputToExecutionLog` depends on | `filterOutputForResource` implementation not read |

---

## Critical Path

### Fix 1 — Output finalization barriers (Findings #1 + #2, `output-file.ts:232`, `236–238`)

These two bugs share a root cause: `closeStaleHandles` treats `finalizedKeys` as a handle-lifetime cache rather than a permanent write barrier. Fix #1 deletes the finalization key when the stale *handle* closes; fix #2 mass-clears all finalization keys. Together they guarantee every completed task will eventually accept post-footer writes, corrupting every `.output` file on a long-running server. Because the `.output` file is the **source of truth** for Claude fallback snapshots (finding #5) and the only record that survives the 2000-line cap eviction, corrupted files cascade into broken context handoffs. The fix is targeted: in `closeStaleHandles`, skip `finalizedKeys.delete(key)` for any key that is not in `openHandles`; and replace `finalizedKeys.clear()` with a LRU eviction of handle-associated keys only.

### Fix 2 — Routine shutdown without completion (Finding #4, `sdk-session-adapter.ts:1265–1280`)

A task receiving `session.shutdown` with `shutdownType === 'routine'` while `binding.isCompleted === false` stays in `RUNNING` indefinitely. Since this path bypasses `finalizeOutputFile`, the `.output` file also has no footer. The task consumes an in-memory slot until TTL (1hr), blocks the 100-task cap, and its stall-detection alarm fires after 5min creating noise. Adding a single `else` branch that transitions to `COMPLETED` (matching the `handleSessionIdle` pattern at lines 420–444) eliminates all three consequences with zero side effects on the error path.

### Fix 3 — Synchronous 200K-line iteration in `task:///all` + un-debounced status trigger (Findings #9 + #10, `index.ts:580–587`, `195–226`)

Every status change fires an immediate `sendResourceUpdated({ uri: 'task:///all' })` which causes MCP clients to issue a `ReadResource` for `task:///all`, which synchronously scans 100 × 2000 = 200,000 output lines on the event loop. During token rotation—which produces multiple rapid status transitions (RUNNING → RATE_LIMITED → RUNNING)—this creates a CPU cascade that blocks all other MCP responses. The compound fix requires: (a) add the same 1-second debounce to status-change resource notifications that output notifications already have, and (b) move `extractMessageStats` computation out of the per-task map in `task:///all` (replace with a cached field on TaskState updated in `appendOutput`). Either fix alone halves the problem; both together eliminate the cascade.
