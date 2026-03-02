---
applyTo: "src/tools/**/*.ts"
---

# MCP Tool Handler Guidelines

## Input Validation

- All parameters must be validated through Zod schemas in `src/utils/sanitize.ts` before use
- Never access raw arguments without schema parsing
- The Zod schema must match the tool's registered `inputSchema` exactly
- Return `mcpValidationError()` for validation failures — never throw

```typescript
// Avoid — raw access without validation
async function handleTool(args: any) {
  const result = await doWork(args.prompt);
  return { content: [{ type: 'text', text: result }] };
}

// Prefer — schema validation at entry
async function handleTool(args: unknown, ctx?: ToolContext) {
  let parsed;
  try { parsed = MySchema.parse(args); }
  catch (e) { return mcpValidationError('Invalid params: ' + String(e)); }
  const result = await doWork(parsed.prompt);
  return mcpText(result);
}
```

## Spawn Handler Pattern

- All spawn tools use `createSpawnHandler()` factory from `shared-spawn.ts`
- The flow is: Zod parse → `validateBrief()` → `assemblePromptWithContext()` → `applyTemplate()` → `spawnCopilotTask()`
- Brief validation enforces per-role rules: prompt min length, context file requirements, `.md` file requirement for coders
- File limits: max 20 files, 200KB each, 500KB total — enforced by `brief-validator.ts`

## Error Handling

- Wrap every tool handler body in try-catch
- Use `mcpError()` for runtime failures, `mcpValidationError()` for input issues
- Log full errors server-side with `console.error()` — return sanitized messages to client
- Never let unhandled exceptions escape a tool handler

## Response Format

- Always use `mcpText()` or `mcpError()` from `src/utils/format.ts`
- Raw `{ content: [...] }` objects bypass error formatting and table escaping
