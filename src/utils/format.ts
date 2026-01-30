/**
 * Shared formatting helpers for converting MCP tool responses to markdown.
 */

/** Wraps a markdown string in the MCP response shape. */
export function mcpText(markdown: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text: markdown }] };
}

/** Display status in human-readable form: "rate_limited" -> "rate limited" */
export function displayStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

/** Format labels as inline code: "`label-a`, `label-b`". Returns empty string if none. */
export function formatLabels(labels?: string[]): string {
  if (!labels || labels.length === 0) return '';
  return labels.map(l => `\`${l}\``).join(', ');
}

/** "Labels: `a`, `b`" or empty string. */
export function formatLabelsLine(labels?: string[]): string {
  const f = formatLabels(labels);
  return f ? `Labels: ${f}` : '';
}

/** Milliseconds to human duration: 541364 -> "~9m" */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `~${totalSec}s`;
  const min = Math.round(totalSec / 60);
  if (min < 60) return `~${min}m`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  return rm === 0 ? `~${h}h` : `~${h}h ${rm}m`;
}

/** Format output as a blockquote with optional truncation. Returns empty string for empty output. */
export function formatOutputBlock(output: string, label = 'Output', maxLen = 2000): string {
  if (!output || !output.trim()) return '';
  let text = output;
  let truncated = false;
  if (text.length > maxLen) {
    text = text.slice(-maxLen);
    truncated = true;
  }
  const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
  const parts = [`**${label}:**`, quoted];
  if (truncated) parts.push('*(truncated -- use `stream_output` for full output)*');
  return parts.join('\n');
}

/** Standard error block with optional actionable hint. */
export function formatError(error: string, hint?: string): string {
  const parts = [`**Error:** ${error}`];
  if (hint) parts.push('', hint);
  return parts.join('\n');
}

/** "Run `sleep 120` then check again." or empty string. */
export function formatRetryHint(retryCommand?: string): string {
  if (!retryCommand) return '';
  return `Run \`${retryCommand}\` then check again.`;
}

/** Escape pipe characters in table cell content. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Render a markdown table from headers and rows. */
export function formatTable(headers: string[], rows: string[][]): string {
  const headerRow = `| ${headers.map(escapeCell).join(' | ')} |`;
  const separator = `|${headers.map(() => '------').join('|')}|`;
  const dataRows = rows.map(r => `| ${r.map(escapeCell).join(' | ')} |`);
  return [headerRow, separator, ...dataRows].join('\n');
}

/** Join non-empty strings with newlines, filtering out falsy/empty values. */
export function join(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(p => typeof p === 'string' && p.length > 0).join('\n');
}
