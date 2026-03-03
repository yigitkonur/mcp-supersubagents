# The Spawn Pipeline: MCP Tool Call to Provider Entry

This document traces the exact code path from when a client calls `spawn_agent` to the point where provider-specific code takes over. This is where you plug in your new provider.

---

## 1. Entry: `spawn_agent` Tool Schema

The `spawn_agent` tool is defined in `src/tools/spawn-agent.ts`. It accepts a Zod-validated schema with these key fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `role` | enum: `coder`, `planner`, `tester`, `researcher`, `general` | Yes | Maps to task type |
| `prompt` | string | Yes | The task description / brief |
| `context_files` | string[] | No | Absolute paths to context files |
| `model` | enum: `claude-sonnet-4.6`, `claude-opus-4.6`, `claude-haiku-4.5` | No | Planner always forced to Opus |
| `timeout` | number | No | ms, default 30min, max 1hr |
| `depends_on` | string[] | No | Task IDs that must complete first |
| `labels` | string[] | No | Max 10, 50 chars each |
| `mode` | enum: `fleet`, `plan`, `autopilot` | No | Default: `fleet` |
| `cwd` | string | No | Working directory override |
| `resume_session_id` | string | No | Resume an existing session |

## 2. Zod Validation

The schema is parsed via `SpawnAgentSchema.parse(args)`. Invalid input throws a Zod error that surfaces as an MCP error response. No custom validation happens at this stage.

## 3. Role → TaskType Mapping

```typescript
// src/tools/spawn-agent.ts
const ROLE_TO_TASK_TYPE: Record<string, TaskType> = {
  coder:      'super-coder',
  planner:    'super-planner',
  tester:     'super-tester',
  researcher: 'super-researcher',
  general:    'super-general',
};
```

The `TaskType` determines which `.mdx` template is loaded.

## 4. Model Override

```typescript
// src/models.ts:30-40
export function resolveModel(requested?: string, taskType?: string): ModelId {
  // Planner always uses Opus regardless of request
  if (taskType === 'super-planner') return 'claude-opus-4.6';

  // Alias resolution
  if (requested === 'opus') return 'claude-opus-4.6';
  if (requested === 'sonnet') return 'claude-sonnet-4.6';

  // Default
  return (requested as ModelId) || 'claude-sonnet-4.6';
}
```

The `ENABLE_OPUS` env var controls whether Opus appears in the tool schema enum — but Opus is always accepted as an alias regardless.

## 5. `handleSharedSpawn()` Orchestrator

After Zod parsing and role mapping, the handler calls `createSpawnHandler()` from `src/tools/shared-spawn.ts`. This is the shared pipeline that all roles use:

```
spawn-agent.ts handler
  └── createSpawnHandler(taskType)
        └── handleSharedSpawn(params)
              1. Validate brief (prompt quality, context files)
              2. Assemble prompt with context file contents
              3. Apply template (role-specific .mdx)
              4. Dispatch to provider (spawnCopilotTask)
```

## 6. Brief Validation

`validateBrief()` from `src/utils/brief-validator.ts` checks input quality per role:

| Rule | Coder | Planner | Tester | Researcher | General |
|------|:-----:|:-------:|:------:|:----------:|:-------:|
| Min prompt length | 1000 chars | 300 chars | 300 chars | 200 chars | 200 chars |
| Context files required | Yes (min 1) | No | Yes (min 1) | No | No |
| `.md` extension required | Yes | No | No | No | No |
| Max files | 20 | 20 | 20 | 20 | 20 |
| Max file size | 200KB | 200KB | 200KB | 200KB | 200KB |
| Max total size | 500KB | 500KB | 500KB | 500KB | 500KB |

Validation failures return structured error messages. The prompt length check uses the **raw user prompt** before template wrapping.

## 7. Context File Assembly

`assemblePromptWithContext()` reads each context file from disk and appends it to the prompt:

```typescript
// src/utils/brief-validator.ts
export async function assemblePromptWithContext(
  prompt: string,
  contextFiles: string[]
): Promise<string>
```

Each file is wrapped in a header block:

```
--- File: /path/to/file.md ---
<file content>
--- End: /path/to/file.md ---
```

The assembled prompt is what gets passed to the template system.

## 8. Template Application

`applyTemplate()` from `src/templates/index.ts` loads and composes the final prompt:

```typescript
export function applyTemplate(taskType: TaskType, userPrompt: string): string
```

1. Loads the base template file (e.g., `super-coder.mdx`)
2. Filters TOOLKIT table rows if `MCP_ENABLED_TOOLS` env var is set
3. Replaces `{{user_prompt}}` with the assembled prompt
4. If no `{{user_prompt}}` placeholder, appends after `---` separator

The result is a large prompt document with role-specific instructions + toolkit reference + the user's actual task.

## 9. The Dispatch Point

After template assembly, `handleSharedSpawn()` calls `spawnCopilotTask()`:

```typescript
// src/tools/shared-spawn.ts (simplified)
const taskId = await spawnCopilotTask({
  prompt: finalPrompt,
  cwd,
  model,
  timeout,
  dependsOn,
  labels,
  mode,
  taskType,
});
```

**This is where your provider plugs in.** You would either:
- Replace `spawnCopilotTask()` with your own spawner
- Add routing logic before the dispatch to choose between providers
- Add a new dispatch function alongside `spawnCopilotTask()`

## 10. `SpawnOptions` — The Contract

```typescript
// src/types.ts:292-309
export interface SpawnOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  timeout?: number;
  dependsOn?: string[];
  labels?: string[];
  provider?: Provider;
  fallbackAttempted?: boolean;
  switchAttempted?: boolean;
  retryInfo?: RetryInfo;
  resumeSessionId?: string;
  mode?: AgentMode;
  taskType?: string;
  reasoningEffort?: string;
}
```

Your provider spawner function should accept `SpawnOptions` and return a `Promise<string>` (the task ID).

## 11. Where and How to Add Provider Routing

The simplest approach is to modify `shared-spawn.ts` to route based on a provider selection strategy:

```typescript
// Example: Add provider routing in shared-spawn.ts
async function dispatchToProvider(options: SpawnOptions): Promise<string> {
  const provider = selectProvider(options);  // your selection logic

  switch (provider) {
    case 'copilot':
      return spawnCopilotTask(options);
    case 'openai-codex':
      return spawnOpenAICodexTask(options);  // your new function
    case 'claude-cli':
      return spawnClaudeTask(options);
    default:
      return spawnCopilotTask(options);
  }
}
```

Provider selection strategies:
- **Environment variable** — `MCP_PROVIDER=openai-codex`
- **Per-request parameter** — Add `provider` to `SpawnAgentSchema`
- **Automatic** — Based on available credentials/SDK

## Flow Diagram

```
MCP Client
    │
    ▼
spawn_agent tool handler (spawn-agent.ts)
    │
    ├── Zod schema validation
    ├── Role → TaskType mapping
    ├── Model resolution (planner → Opus)
    │
    ▼
handleSharedSpawn (shared-spawn.ts)
    │
    ├── validateBrief()          ← prompt quality, context files
    ├── assemblePromptWithContext() ← reads files, appends to prompt
    ├── applyTemplate()          ← .mdx template + user prompt
    │
    ▼
┌─────────────────────────────────────────────┐
│           DISPATCH POINT                     │
│  spawnCopilotTask(options)                   │
│                                              │
│  ← YOUR PROVIDER PLUGS IN HERE             │
│                                              │
│  Returns: Promise<string> (task ID)          │
└─────────────────────────────────────────────┘
    │
    ▼
MCP Response: { taskId, status: 'pending' }
```

---

**Previous:** [03 — Task Manager Contract](./03-task-manager-contract.md) · **Next:** [05 — Provider Reference: Copilot](./05-provider-reference-copilot.md)
