# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to build/
npm run dev          # Watch mode with tsx (auto-reload)
npm start            # Run compiled server
npm run clean        # Remove build directory
```

## Architecture Overview

This is an MCP (Model Context Protocol) server that spawns GitHub Copilot CLI agents as background tasks. It wraps the Copilot CLI (`/opt/homebrew/bin/copilot` by default) with task management, dependency chains, and automatic rate-limit retry.

### Core Components

**Entry Point** (`src/index.ts`): Sets up MCP server, registers all tools, and wires up task manager callbacks for retry and dependency execution.

**Task Manager** (`src/services/task-manager.ts`): Central state machine managing all tasks. Handles:
- Task lifecycle (pending → waiting → running → completed/failed/cancelled/rate_limited/timed_out)
- Dependency resolution via `areDependenciesSatisfied()` and `processWaitingTasks()`
- Persistence scheduling with debouncing
- Auto-cleanup of expired tasks (1 hour TTL)

**Process Spawner** (`src/services/process-spawner.ts`): Executes Copilot CLI via `execa`. Builds command args, captures stdout/stderr, detects rate limits, and handles timeouts.

**Persistence** (`src/services/task-persistence.ts`): Tasks persist to `~/.super-agents/{md5(cwd)}.json`. Uses atomic writes (write temp → rename).

**Retry Queue** (`src/services/retry-queue.ts`): Detects rate-limit errors via regex patterns, calculates exponential backoff (5m → 10m → 20m → 40m → 1h → 2h), and extracts wait times from error messages.

### Tool Handlers

Each tool in `src/tools/` exports:
- A tool definition object (`{name, description, inputSchema}`)
- A handler function that validates input via Zod schemas from `src/utils/sanitize.ts`

### Templates

Task templates in `src/templates/*.mdx` wrap user prompts with specialized instructions. The `applyTemplate()` function replaces `{{user_prompt}}` placeholder or appends if not found.

### Key Types

- `TaskStatus` enum: `pending`, `waiting`, `running`, `completed`, `failed`, `cancelled`, `rate_limited`, `timed_out`
- `TaskState`: Full task object with output buffer, retry info, dependencies, labels
- `SpawnOptions`: Input for creating tasks

### Task IDs

Human-readable IDs like `brave-tiger-42` generated via `unique-names-generator`. Normalized to lowercase for lookups.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `COPILOT_PATH` | `/opt/homebrew/bin/copilot` | Path to Copilot CLI executable |
| `ENABLE_OPUS` | `false` | Allow opus model (cost control) |
| `ENABLE_STREAMING` | `false` | Enable experimental `stream_output` tool |

## Adding New Tools

1. Create `src/tools/new-tool.ts` with tool definition and handler
2. Import and add to `tools` array in `src/index.ts`
3. Add case to switch statement in `CallToolRequestSchema` handler
