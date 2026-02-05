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

/** Standard error block with optional actionable hint. */
export function formatError(error: string, hint?: string): string {
  const parts = [`**Error:** ${error}`];
  if (hint) parts.push('', hint);
  return parts.join('\n');
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
