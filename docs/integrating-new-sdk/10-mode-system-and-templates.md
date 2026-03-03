# Execution Modes, Templates, and Brief Validation

This document covers the input processing layer that constrains and enriches what the provider receives. Understanding modes, templates, and validation is necessary for correctly applying behavioral instructions to your provider's sessions.

---

## 1. The Three Execution Modes

```typescript
// src/types.ts
export type AgentMode = 'fleet' | 'plan' | 'autopilot';
export const DEFAULT_AGENT_MODE: AgentMode = 'fleet';
```

| Mode | Behavior | Use Case |
|------|----------|----------|
| `autopilot` | Direct execution, no suffix prompt | Simple tasks, maximum speed |
| `plan` | Plan-first suffix prompt appended | Complex tasks requiring upfront design |
| `fleet` | Parallel sub-agents suffix + fleet RPC | Default — enables parallel execution |

All modes auto-run. Despite the name, `plan` mode does NOT block for human approval — it instructs the agent to plan first, then execute.

## 2. Mode Suffix Prompts

From `src/config/mode-prompts.ts`:

```typescript
export const MODE_SUFFIX_PROMPTS: Record<AgentMode, string> = {
  autopilot: '',  // No suffix — direct execution

  plan: `
--- EXECUTION MODE: PLAN-FIRST ---
Before writing any code, create a detailed plan:
1. Analyze the requirements and identify all files to modify
2. List the changes needed in each file
3. Consider edge cases and potential issues
4. Then execute the plan step by step
---`,

  fleet: `
--- EXECUTION MODE: FLEET (PARALLEL AGENTS) ---
You have access to parallel sub-agents. Use them to:
1. Break complex tasks into independent sub-tasks
2. Execute sub-tasks in parallel when possible
3. Coordinate results from parallel executions
4. Use sub-agents for: research, testing, implementation of independent components
---`,
};

export function getModeSuffixPrompt(mode: AgentMode): string {
  return MODE_SUFFIX_PROMPTS[mode] || '';
}
```

The suffix is appended to the user's prompt **after** template application:

```typescript
const modeSuffix = getModeSuffixPrompt(effectiveMode);
const finalPrompt = modeSuffix ? prompt + modeSuffix : prompt;
```

## 3. Mode Resolution Priority

```typescript
// sdk-spawner.ts:168
function resolveMode(options: Pick<SpawnOptions, 'mode'>): AgentMode {
  if (options.mode) return options.mode;
  return DEFAULT_AGENT_MODE;  // 'fleet'
}
```

Resolution: explicit `mode` parameter > default (`fleet`).

The legacy `enableFleet` and `autonomous` parameters are accepted in schemas for backward compatibility but ignored in mode resolution.

## 4. How Modes Map Per Provider

| Mode | Copilot SDK | Claude Agent SDK |
|------|-------------|------------------|
| `autopilot` | `rpc.mode.set('autopilot')` | `bypassPermissions` |
| `plan` | `rpc.mode.set('autopilot')` + plan suffix | `bypassPermissions` + plan suffix |
| `fleet` | `rpc.mode.set('autopilot')` + `rpc.fleet.start()` + fleet suffix | `bypassPermissions` + fleet suffix |

Key detail: Copilot's native `plan` mode blocks for human approval via `ask_user`, which deadlocks headless execution. The spawner always sets `rpc.mode.set('autopilot')` and uses suffix prompts for behavioral differentiation.

**For your provider:** Apply the mode suffix prompt to the final prompt. If your SDK has native parallel execution support, wire it to fleet mode.

## 5. Template System

### Base Templates

Templates are `.mdx` files in `src/templates/`:

| File | Task Type | Role |
|------|-----------|------|
| `super-coder.mdx` | `super-coder` | Coding tasks |
| `super-planner.mdx` | `super-planner` | Architecture and planning |
| `super-tester.mdx` | `super-tester` | Testing |
| `super-researcher.mdx` | `super-researcher` | Research and questions |
| `super-general.mdx` | `super-general` | Non-code tasks |

### Template Loading and Caching

```typescript
// src/templates/index.ts
export function applyTemplate(taskType: TaskType, userPrompt: string): string
```

1. Load `.mdx` file from disk (cached after first load)
2. Filter TOOLKIT table rows if `MCP_ENABLED_TOOLS` is set
3. Replace `{{user_prompt}}` placeholder with user prompt
4. If no placeholder found, append user prompt after `---` separator

### `{{user_prompt}}` Injection

Templates contain a `{{user_prompt}}` placeholder where the user's assembled prompt is injected:

```markdown
# Super Coder

You are a coding agent. Follow these instructions...

## TOOLKIT

| Tool | Purpose | When to use |
|------|---------|-------------|
| `Read` | Read files | ... |
| `Edit` | Edit files | ... |

## YOUR TASK

{{user_prompt}}
```

### `MCP_ENABLED_TOOLS` Filtering

When set (comma-separated), only matching tool rows in TOOLKIT tables are kept:

```bash
MCP_ENABLED_TOOLS=playwright-cli,warpgrep_codebase_search,bash
```

The filter matches tool names in backticks at the start of table cells: `| \`tool_name\` |`. Header and separator rows are always kept.

### Build Process

`tsc` only compiles `.ts` files. The build script copies `.mdx` files separately:

```json
// package.json (build script)
"build": "tsc --noEmitOnError false && cp src/templates/*.mdx build/templates/"
```

If you add or rename templates, update the copy commands.

## 6. Brief Validation Rules

From `src/utils/brief-validator.ts`:

### Per-Role Rules

| Rule | Coder | Planner | Tester | Researcher | General |
|------|:-----:|:-------:|:------:|:----------:|:-------:|
| `minPromptLength` | 1000 | 300 | 300 | 200 | 200 |
| `requireContextFiles` | ✅ | ❌ | ✅ | ❌ | ❌ |
| `requireMdExtension` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `modelOverrideAllowed` | ✅ | ❌ (forced Opus) | ✅ | ✅ | ✅ |

### File Limits

| Limit | Value |
|-------|-------|
| Max files per spawn | 20 |
| Max file size | 200KB |
| Max total context size | 500KB |
| File paths | Must be absolute |

### Validation Flow

```typescript
export function validateBrief(
  taskType: TaskType,
  prompt: string,
  contextFiles?: string[],
  model?: string
): ValidationResult
```

Returns `{ valid: true }` or `{ valid: false, errors: string[] }`.

### Context File Assembly

```typescript
export async function assemblePromptWithContext(
  prompt: string,
  contextFiles: string[]
): Promise<string>
```

Reads each file and appends to prompt with headers:

```
--- File: /absolute/path/to/context.md ---
<file content>
--- End: /absolute/path/to/context.md ---
```

## 7. Model Resolution

From `src/models.ts`:

```typescript
export const MODELS = {
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'claude-opus-4.6': 'Claude Opus 4.6',
  'claude-haiku-4.5': 'Claude Haiku 4.5',
} as const;

export type ModelId = keyof typeof MODELS;
```

### Resolution Rules

1. **Planner always Opus** — `resolveModel(anything, 'super-planner')` → `claude-opus-4.6`
2. **Alias support** — `'opus'` → `claude-opus-4.6`, `'sonnet'` → `claude-sonnet-4.6`
3. **Default** — `claude-sonnet-4.6`

### `ENABLE_OPUS` Visibility

The `ENABLE_OPUS` env var controls whether Opus appears in the `spawn_agent` tool schema enum. Regardless of this setting, Opus is always accepted via the `opus` alias. This is a UI/visibility concern, not a capability gate.

---

**Previous:** [09 — Session Metrics](./09-session-metrics-and-observability.md) · **Next:** [11 — Concurrency and Safety](./11-concurrency-and-safety.md)
