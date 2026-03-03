# System Overview and Provider Architecture

This document orients a new developer in 5 minutes. It explains what the MCP server does, what a "provider" means, and where a new provider fits.

---

## 1. What This System Does

This is an **MCP server** (Model Context Protocol) that spawns and manages parallel AI sub-agents. It communicates over **STDIO transport** using JSON-RPC framing and exposes **4 MCP tools**:

| Tool | Purpose |
|------|---------|
| `spawn_agent` | Create a new AI agent task (coder, planner, tester, researcher, general) |
| `send_message` | Send a follow-up message to a running task |
| `cancel_task` | Cancel a running or pending task |
| `answer_question` | Answer a question from an agent's `ask_user` tool |

The server manages task lifecycle, output streaming, persistence, and account rotation — all transparent to the MCP client.

## 2. The Two-Provider Model

A **provider** is an execution backend that runs the AI agent. The system currently has two:

```typescript
// src/types.ts:4
export type Provider = 'copilot' | 'claude-cli';
```

| Provider | Backend | Transport | Primary Use |
|----------|---------|-----------|-------------|
| `copilot` | GitHub Copilot SDK (`@github/copilot-sdk`) | PTY-based sessions, event-driven | Primary — used when PAT tokens are available |
| `claude-cli` | Claude Agent SDK (`ai-sdk-provider-claude-code`) | Stream-based, `LanguageModelV3` | Fallback — used when all Copilot accounts are rate-limited |

**The Copilot provider** creates interactive sessions via the SDK. Events (`session.idle`, `session.error`, `tool.execution_start`, etc.) stream back and are mapped to `TaskState` updates.

**The Claude provider** uses the Vercel AI SDK's streaming interface. Stream parts (`text-delta`, `tool-call`, `tool-result`, etc.) are processed sequentially and mapped to the same `TaskState` model.

Both providers produce the same output: `TaskState` transitions and appended output lines. The MCP client sees no difference.

## 3. What "Adding a New Provider" Means

Adding a provider (e.g., OpenAI Codex) means:

1. Defining a new runner function that accepts a task ID, prompt, and working directory
2. Mapping your SDK's output events/stream to `taskManager.appendOutput()` calls
3. Producing the required `TaskState` transitions: `PENDING → RUNNING → COMPLETED|FAILED`
4. Registering with `processRegistry` for cancellation support
5. Optionally integrating with the fallback chain and mode system

You do **not** need to modify the MCP transport, tool schemas, template system, or persistence layer — those are provider-agnostic.

## 4. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Client                              │
│                    (Claude Code, IDE, etc.)                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ STDIO (JSON-RPC)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MCP Server (index.ts)                      │
│  ┌──────────┐ ┌──────────────┐ ┌───────────┐ ┌──────────────┐  │
│  │spawn_agent│ │send_message  │ │cancel_task│ │answer_question│  │
│  └────┬─────┘ └──────┬───────┘ └─────┬─────┘ └──────┬───────┘  │
│       │              │               │               │          │
│       ▼              │               │               │          │
│  ┌─────────────────┐ │               │               │          │
│  │  Spawn Pipeline │ │               │               │          │
│  │  (shared-spawn) │ │               │               │          │
│  │  Zod → Brief →  │ │               │               │          │
│  │  Template → ...  │ │               │               │          │
│  └────────┬────────┘ │               │               │          │
│           │          │               │               │          │
│           ▼          ▼               ▼               ▼          │
│  ┌──────────────────────────────────────────────────────┐       │
│  │              Task Manager (singleton)                 │       │
│  │  createTask() · updateTask() · appendOutput()         │       │
│  │  State machine · Persistence · Cleanup                │       │
│  └──────────┬───────────────┬───────────────────────────┘       │
│             │               │                                    │
│    ┌────────▼────────┐  ┌──▼──────────────────┐                 │
│    │ Provider A:      │  │ Provider B:          │  ┌───────────┐│
│    │ Copilot SDK      │  │ Claude Agent SDK     │  │Provider C:││
│    │ (sdk-spawner +   │  │ (claude-code-runner) │  │YOUR NEW   ││
│    │  session-adapter │  │                      │  │PROVIDER   ││
│    │  + client-mgr)   │  │                      │  │  (here)   ││
│    └────────┬─────────┘  └──────────┬───────────┘  └─────┬─────┘│
│             │                       │                     │      │
│    ┌────────▼───────────────────────▼─────────────────────▼────┐ │
│    │              Supporting Services                           │ │
│    │  processRegistry · questionRegistry · outputFile           │ │
│    │  taskPersistence · accountManager · fallbackOrchestrator   │ │
│    └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## 5. The Spawn Flow at 10,000 Feet

When a client calls `spawn_agent`, the server validates input via Zod, checks brief quality (prompt length, context files), assembles the prompt with context file contents, applies the role's `.mdx` template, creates a `TaskState` in the task manager, and dispatches to the active provider — currently always trying Copilot first and falling back to Claude if all accounts are exhausted. The task ID is returned immediately; execution runs in the background.

## 6. Directory Map

```
src/
├── index.ts                          # MCP server setup, STDIO transport
├── types.ts                          # All type definitions (TaskState, enums, metrics)
├── models.ts                         # Model catalog, resolution, aliases
│
├── config/
│   ├── mode-prompts.ts               # Mode suffix prompts (fleet/plan/autopilot)
│   └── timeouts.ts                   # Timeout constants (env-overridable)
│
├── tools/
│   ├── spawn-agent.ts                # spawn_agent MCP tool (Zod schema, handler)
│   ├── shared-spawn.ts               # Shared spawn pipeline (validation → template → dispatch)
│   ├── send-message.ts               # send_message MCP tool
│   ├── cancel-task.ts                # cancel_task MCP tool
│   └── answer-question.ts            # answer_question MCP tool
│
├── templates/
│   ├── index.ts                      # Template loading, caching, filtering
│   ├── super-coder.mdx               # Base template for coder role
│   ├── super-planner.mdx             # Base template for planner role
│   ├── super-tester.mdx              # Base template for tester role
│   ├── super-researcher.mdx          # Base template for researcher role
│   └── super-general.mdx             # Base template for general role
│
├── services/
│   ├── task-manager.ts               # Central state machine (THE singleton)
│   ├── task-status-mapper.ts         # Internal 8-state → MCP 5-state mapping
│   ├── task-persistence.ts           # Atomic disk persistence
│   ├── sdk-spawner.ts                # Copilot SDK spawner (dispatch entry point)
│   ├── sdk-client-manager.ts         # Copilot client pooling, session lifecycle
│   ├── sdk-session-adapter.ts        # Event→TaskState mapping, rotation protocol
│   ├── claude-code-runner.ts         # Claude Agent SDK fallback runner
│   ├── account-manager.ts            # Multi-account PAT token rotation
│   ├── fallback-orchestrator.ts      # Single-flight fallback trigger
│   ├── exhaustion-fallback.ts        # Fallback decision logic
│   ├── output-file.ts                # Output file management (.super-agents/)
│   ├── process-registry.ts           # Process tracking, kill escalation
│   ├── question-registry.ts          # User input (ask_user) handling
│   ├── progress-registry.ts          # MCP progress notifications
│   ├── subscription-registry.ts      # MCP resource subscriptions
│   ├── client-context.ts             # MCP client workspace context
│   ├── session-hooks.ts              # SDK session lifecycle hooks
│   └── retry-queue.ts                # Exponential backoff for rate limits
│
└── utils/
    ├── brief-validator.ts            # Input validation per role
    ├── tool-summarizer.ts            # Compact tool output formatting
    ├── task-id-generator.ts          # Unique task ID generation
    └── format.ts                     # MCP response formatting helpers
```

## 7. Key Files Reference Table

| File | Role | Singleton Name |
|------|------|----------------|
| `src/services/task-manager.ts` | Central task state machine | `taskManager` |
| `src/services/sdk-client-manager.ts` | Copilot SDK client pooling | `sdkClientManager` |
| `src/services/sdk-session-adapter.ts` | SDK event→state mapping | `sdkSessionAdapter` |
| `src/services/account-manager.ts` | PAT token rotation | `accountManager` |
| `src/services/process-registry.ts` | Process tracking & kill | `processRegistry` |
| `src/services/question-registry.ts` | User input handling | `questionRegistry` |
| `src/services/progress-registry.ts` | MCP progress notifications | `progressRegistry` |
| `src/services/subscription-registry.ts` | MCP resource subscriptions | `subscriptionRegistry` |
| `src/services/client-context.ts` | MCP client context | `clientContext` |

Every service follows the same singleton pattern:

```typescript
class ServiceName { ... }
export const serviceName = new ServiceName();
```

Services import each other's singletons directly. Circular dependencies are broken with lazy `await import()` inside methods.

## 8. Critical Constraint: STDIO Logging

**All logging must use `console.error` (stderr)**. Any `console.log` corrupts the MCP JSON-RPC framing and silently breaks all connected clients. This is the most common cause of production incidents.

---

**Next:** [02 — Task State Machine and Lifecycle](./02-task-lifecycle.md)
