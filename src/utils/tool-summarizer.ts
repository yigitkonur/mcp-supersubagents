/**
 * Tool output summarizer — produces compact one-line summaries for tool
 * executions based on tool name, arguments, and results.
 *
 * Used by both sdk-session-adapter (Copilot SDK) and claude-code-runner
 * (Claude Agent SDK fallback) to replace verbose generic lines like
 * "[tool] Completed: Read (2214ms)" with informative summaries like
 * "[tool] read …/sdk-session-adapter.ts:195-255 (2.2s)".
 */

// ── Types ──────────────────────────────────────────────────────

export interface ToolCallContext {
  toolName: string;
  filePath?: string;
  offset?: number;
  limit?: number;
  command?: string;
  pattern?: string;
  glob?: string;
  contentLines?: number;
  oldLines?: number;
  newLines?: number;
  query?: string;
  url?: string;
  description?: string;
  subagentType?: string;
  instruction?: string;
  mcpServer?: string;     // Extracted from mcp__<server>__<tool> pattern
  mcpTool?: string;       // Tool name within MCP namespace
  mcpHint?: string;       // First string arg as hint for MCP tools
}

export interface ToolResultInfo {
  duration?: number;
  success?: boolean;
  error?: string;
  exitCode?: number;
  resultCount?: number;
}

// ── Helpers ────────────────────────────────────────────────────

/** Show last 3 path segments: …/dir/subdir/file.ts */
function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return '…/' + parts.slice(-3).join('/');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Context Extraction ─────────────────────────────────────────

/**
 * Extract summary-relevant context from tool arguments.
 * Only captures small scalar values — never stores full file content.
 */
export function extractToolContext(toolName: string, rawArgs: unknown): ToolCallContext {
  const ctx: ToolCallContext = { toolName };
  if (!rawArgs || typeof rawArgs !== 'object') return ctx;

  const a = rawArgs as Record<string, unknown>;
  const norm = toolName.toLowerCase();

  // File path (common across Read, Write, Edit, NotebookEdit, morph edit)
  const fp = a.file_path ?? a.path ?? a.notebook_path;
  if (typeof fp === 'string') ctx.filePath = fp;

  if (norm === 'read') {
    if (typeof a.offset === 'number') ctx.offset = a.offset;
    if (typeof a.limit === 'number') ctx.limit = a.limit;
  } else if (norm === 'write') {
    if (typeof a.content === 'string') ctx.contentLines = a.content.split('\n').length;
  } else if (norm === 'edit') {
    if (typeof a.old_string === 'string') ctx.oldLines = a.old_string.split('\n').length;
    if (typeof a.new_string === 'string') ctx.newLines = a.new_string.split('\n').length;
  } else if (norm.includes('edit_file')) {
    // mcp__morph__edit_file or similar
    if (typeof a.instruction === 'string') ctx.instruction = a.instruction;
  } else if (norm === 'bash' || norm === 'shell' || norm === 'terminal') {
    if (typeof a.command === 'string') ctx.command = a.command;
  } else if (norm === 'grep') {
    if (typeof a.pattern === 'string') ctx.pattern = a.pattern;
    if (typeof a.glob === 'string') ctx.glob = a.glob;
  } else if (norm === 'glob') {
    if (typeof a.pattern === 'string') ctx.pattern = a.pattern;
  } else if (norm === 'websearch') {
    if (typeof a.query === 'string') ctx.query = a.query;
  } else if (norm === 'webfetch') {
    if (typeof a.url === 'string') ctx.url = a.url;
  } else if (norm === 'task') {
    if (typeof a.description === 'string') ctx.description = a.description;
    if (typeof a.subagent_type === 'string') ctx.subagentType = a.subagent_type;
  } else if (norm === 'notebookedit') {
    if (typeof a.edit_mode === 'string') ctx.instruction = a.edit_mode;
  }

  // MCP namespaced tools: mcp__<server>__<tool>
  if (toolName.startsWith('mcp__') && !ctx.filePath && !ctx.command) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      ctx.mcpServer = parts[1];
      ctx.mcpTool = parts.slice(2).join('_');
      // Extract first short string arg as a display hint
      for (const v of Object.values(a)) {
        if (typeof v === 'string' && v.length > 0 && v.length <= 100) {
          ctx.mcpHint = v;
          break;
        }
      }
    }
  }

  return ctx;
}

// ── Result Info Extraction ─────────────────────────────────────

/**
 * Extract summary-relevant info from a tool result.
 * Handles both Copilot SDK (rich contents structure) and
 * Claude fallback (JSONValue) result shapes.
 */
export function extractResultInfo(toolName: string, rawResult: unknown): Partial<ToolResultInfo> {
  const norm = toolName.toLowerCase();
  const info: Partial<ToolResultInfo> = {};
  if (rawResult == null) return info;

  const isObj = typeof rawResult === 'object' && !Array.isArray(rawResult);
  const r = isObj ? (rawResult as Record<string, unknown>) : {};

  // Bash / shell: extract exit code
  if (norm === 'bash' || norm === 'shell' || norm === 'terminal') {
    // Claude fallback: { exitCode: number, ... }
    if (typeof r.exitCode === 'number') info.exitCode = r.exitCode;
    // Copilot SDK: result.contents[{ type: 'terminal', exitCode }]
    if (Array.isArray(r.contents)) {
      for (const c of r.contents) {
        if (c && typeof c === 'object' && (c as any).type === 'terminal' && typeof (c as any).exitCode === 'number') {
          info.exitCode = (c as any).exitCode;
          break;
        }
      }
    }
  }

  // Glob / Grep: count results
  if (norm === 'glob' || norm === 'grep') {
    if (Array.isArray(rawResult)) {
      info.resultCount = rawResult.length;
    } else if (typeof rawResult === 'string' && rawResult.length > 0) {
      info.resultCount = rawResult.split('\n').filter(Boolean).length;
    } else if (typeof r.content === 'string' && r.content.length > 0) {
      // SDK result.content is a newline-separated list
      info.resultCount = r.content.split('\n').filter(Boolean).length;
    }
  }

  return info;
}

// ── Formatting ─────────────────────────────────────────────────

/**
 * Format a compact start line for file-only output (streaming tail).
 * Used by the Copilot SDK path where args are available at start time.
 */
export function formatToolStart(ctx: ToolCallContext): string {
  const norm = ctx.toolName.toLowerCase();
  const path = ctx.filePath ? shortenPath(ctx.filePath) : '';

  if (norm === 'read') {
    let range = '';
    if (ctx.offset) {
      const end = ctx.limit ? String(ctx.offset + ctx.limit) : '';
      range = end ? `:${ctx.offset}-${end}` : `:${ctx.offset}+`;
    }
    return path ? `Starting: read ${path}${range}` : `Starting: ${ctx.toolName}`;
  }
  if (norm === 'write') {
    const lines = ctx.contentLines ? ` (${ctx.contentLines} lines)` : '';
    return path ? `Starting: write ${path}${lines}` : `Starting: ${ctx.toolName}`;
  }
  if (norm === 'edit') {
    return path ? `Starting: edit ${path}` : `Starting: ${ctx.toolName}`;
  }
  if (norm.includes('edit_file')) {
    return path ? `Starting: morph-edit ${path}` : `Starting: ${ctx.toolName}`;
  }
  if (norm === 'bash' || norm === 'shell' || norm === 'terminal') {
    return ctx.command ? `Starting: $ ${truncate(ctx.command, 60)}` : `Starting: ${ctx.toolName}`;
  }
  if (norm === 'grep') {
    const pat = ctx.pattern ? ` "${truncate(ctx.pattern, 30)}"` : '';
    return `Starting: grep${pat}`;
  }
  if (norm === 'glob') {
    const pat = ctx.pattern ? ` "${truncate(ctx.pattern, 30)}"` : '';
    return `Starting: glob${pat}`;
  }
  if (norm === 'websearch') {
    return ctx.query ? `Starting: search "${truncate(ctx.query, 40)}"` : `Starting: ${ctx.toolName}`;
  }
  if (norm === 'webfetch') {
    return ctx.url ? `Starting: fetch ${truncate(ctx.url, 50)}` : `Starting: ${ctx.toolName}`;
  }
  if (norm === 'task') {
    const type = ctx.subagentType || '';
    const desc = ctx.description ? `"${truncate(ctx.description, 35)}"` : '';
    return type ? `Starting: spawn ${type} ${desc}`.trim() : `Starting: Task ${desc}`.trim();
  }
  // MCP namespaced tools
  if (ctx.mcpServer && ctx.mcpTool) {
    const hint = ctx.mcpHint ? ` ("${truncate(ctx.mcpHint, 30)}")` : '';
    return `Starting: MCP:${ctx.mcpServer} ${ctx.mcpTool}${hint}`;
  }
  return `Starting: ${ctx.toolName}`;
}

/**
 * Format a compact completion line for in-memory output.
 * Includes rich context from args + result info.
 */
export function formatToolComplete(ctx: ToolCallContext, info: ToolResultInfo): string {
  const dur = info.duration ? ` (${fmtDur(info.duration)})` : '';
  const norm = ctx.toolName.toLowerCase();

  // Failure
  if (info.success === false) {
    const errMsg = info.error ? ` — ${truncate(info.error, 80)}` : '';
    return `Failed: ${ctx.toolName}${errMsg}${dur}`;
  }

  const path = ctx.filePath ? shortenPath(ctx.filePath) : '';

  // ── File tools ──
  if (norm === 'read') {
    let range = '';
    if (ctx.offset) {
      const end = ctx.limit ? String(ctx.offset + ctx.limit) : '';
      range = end ? `:${ctx.offset}-${end}` : `:${ctx.offset}+`;
    }
    return path ? `read ${path}${range}${dur}` : `${ctx.toolName}${dur}`;
  }

  if (norm === 'write') {
    const lines = ctx.contentLines ? ` (${ctx.contentLines} lines)` : '';
    return path ? `write ${path}${lines}${dur}` : `${ctx.toolName}${lines}${dur}`;
  }

  if (norm === 'edit') {
    const diff = (ctx.newLines || ctx.oldLines) ? ` (+${ctx.newLines ?? 0}/-${ctx.oldLines ?? 0})` : '';
    return path ? `edit ${path}${diff}${dur}` : `${ctx.toolName}${diff}${dur}`;
  }

  if (norm.includes('edit_file')) {
    const inst = ctx.instruction ? ` "${truncate(ctx.instruction, 40)}"` : '';
    return path ? `morph-edit ${path}${inst}${dur}` : `morph-edit${inst}${dur}`;
  }

  if (norm === 'notebookedit') {
    const mode = ctx.instruction ? ` (${ctx.instruction})` : '';
    return path ? `notebook ${shortenPath(path)}${mode}${dur}` : `${ctx.toolName}${mode}${dur}`;
  }

  // ── Shell ──
  if (norm === 'bash' || norm === 'shell' || norm === 'terminal') {
    const cmd = ctx.command ? truncate(ctx.command, 60) : '';
    const exit = info.exitCode !== undefined ? ` → exit ${info.exitCode}` : '';
    return cmd ? `$ ${cmd}${exit}${dur}` : `${ctx.toolName}${exit}${dur}`;
  }

  // ── Search ──
  if (norm === 'grep') {
    const pat = ctx.pattern ? ` "${truncate(ctx.pattern, 30)}"` : '';
    const scope = ctx.glob ? ` in ${ctx.glob}` : '';
    const count = info.resultCount !== undefined ? ` → ${info.resultCount} matches` : '';
    return `grep${pat}${scope}${count}${dur}`;
  }

  if (norm === 'glob') {
    const pat = ctx.pattern ? ` "${truncate(ctx.pattern, 30)}"` : '';
    const count = info.resultCount !== undefined ? ` → ${info.resultCount} files` : '';
    return `glob${pat}${count}${dur}`;
  }

  if (norm === 'websearch') {
    const q = ctx.query ? ` "${truncate(ctx.query, 40)}"` : '';
    return `search${q}${dur}`;
  }

  // ── Network ──
  if (norm === 'webfetch') {
    const u = ctx.url ? ` ${truncate(ctx.url, 50)}` : '';
    return `fetch${u}${dur}`;
  }

  // ── Agent / Task ──
  if (norm === 'task') {
    const type = ctx.subagentType || '';
    const desc = ctx.description ? ` "${truncate(ctx.description, 40)}"` : '';
    return type ? `spawn ${type}${desc}${dur}` : `Task${desc}${dur}`;
  }

  if (norm === 'taskoutput') {
    return `task-output${dur}`;
  }

  // ── MCP namespaced ──
  if (ctx.mcpServer && ctx.mcpTool) {
    const hint = ctx.mcpHint ? ` ("${truncate(ctx.mcpHint, 30)}")` : '';
    return `MCP:${ctx.mcpServer} ${ctx.mcpTool}${hint}${dur}`;
  }

  // ── Default ──
  return `${ctx.toolName}${dur}`;
}

// ── Execution Log Helper ──────────────────────────────────────

/**
 * Extract a display tool name from a compressed detail string.
 * Used by execution log parsers to recover a tool category.
 *
 *   "read …/sdk-session-adapter.ts:195-255"  -> "Read"
 *   "$ npm test → exit 0"                     -> "Bash"
 *   "edit …/app.ts (+3/-2)"                   -> "Edit"
 *   "MCP:github list_issues"                  -> "MCP:github"
 *   "Read"                                    -> "Read" (legacy)
 */
export function extractToolNameFromDetail(detail: string): string {
  if (detail.startsWith('read '))    return 'Read';
  if (detail.startsWith('write '))   return 'Write';
  if (detail.startsWith('edit '))    return 'Edit';
  if (detail.startsWith('morph-edit ')) return 'Edit';
  if (detail.startsWith('notebook ')) return 'NotebookEdit';
  if (detail.startsWith('$ '))       return 'Bash';
  if (detail.startsWith('grep'))     return 'Grep';
  if (detail.startsWith('glob'))     return 'Glob';
  if (detail.startsWith('search'))   return 'WebSearch';
  if (detail.startsWith('fetch'))    return 'WebFetch';
  if (detail.startsWith('spawn '))   return 'Task';
  if (detail.startsWith('Task'))     return 'Task';
  if (detail.startsWith('task-output')) return 'TaskOutput';
  if (detail.startsWith('MCP:')) {
    const spaceIdx = detail.indexOf(' ');
    return spaceIdx > 0 ? detail.slice(0, spaceIdx) : detail;
  }
  // Generic: first word
  const firstSpace = detail.indexOf(' ');
  return firstSpace > 0 ? detail.slice(0, firstSpace) : detail;
}
