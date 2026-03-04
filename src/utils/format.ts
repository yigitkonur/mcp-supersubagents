/**
 * Shared formatting helpers for converting MCP tool responses to markdown.
 */

/** Standard MCP tool response shape. */
export type McpToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

/** Wraps a markdown string in the MCP response shape. */
export function mcpText(markdown: string): McpToolResponse {
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

/** MCP-compliant validation error response with isError: true. */
export function mcpValidationError(markdown: string): McpToolResponse & { isError: true } {
  return { content: [{ type: 'text', text: markdown }], isError: true as const };
}

/** MCP-compliant error response with optional actionable hint. */
export function mcpError(error: string, hint?: string): McpToolResponse & { isError: true } {
  const text = hint ? `**Error:** ${error}\n\n${hint}` : `**Error:** ${error}`;
  return { content: [{ type: 'text', text }], isError: true as const };
}

/** Escape pipe characters and newlines in table cell content. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Render a markdown table from headers and rows. */
export function formatTable(headers: string[], rows: string[][]): string {
  const headerRow = `| ${headers.map(escapeCell).join(' | ')} |`;
  const separator = `|${headers.map(() => '------').join('|')}|`;
  const dataRows = rows.map(r => `| ${r.map(escapeCell).join(' | ')} |`);
  return [headerRow, separator, ...dataRows].join('\n');
}
