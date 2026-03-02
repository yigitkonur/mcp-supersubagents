---
applyTo: "src/**/*.ts"
---

# Security Review Guidelines

## Token & Credential Handling

- PAT tokens must **never** appear in log output, error messages, or MCP responses
- Only `getMaskedCurrentToken()` output is safe to log — review any code touching `exportCooldownState()` or token iteration
- The `account-manager.ts` round-robin rotates tokens with 60s cooldown on failure — changes must preserve this timing
- `task.fallbackAttempted` is a single-flight guard — `triggerClaudeFallback()` is a no-op if already true

## Input Boundary Validation

- Tool handlers in `src/tools/` are the primary input boundary
- All parameters must go through Zod schemas in `src/utils/sanitize.ts` before use
- File path parameters (`context_files[].path`, `cwd`) must be absolute — `isAbsolute()` check in `brief-validator.ts` must not be bypassed
- The `cwd` option is validated against workspace root using `realpath()` containment and `startsWith(resolvedRoot + '/')` boundary check

## Path Traversal Prevention

- The `specialization` parameter is used in `join(__dirname, 'overlays', ...)` for template loading
- It must not contain path traversal characters (`..`, `/`, `\`) — any modification must add or preserve pattern validation
- Context file paths must be verified as absolute before reading

## Dangerous Command Filtering

- `claude-code-runner.ts` filters dangerous bash commands (`rm -rf /`, `mkfs`, `dd`, `shutdown`, `reboot`, `chown`)
- Changes to the tool policy filter must not weaken this list
- Control characters are stripped from user answers in `question-registry.ts` (`\x00-\x1f`, `\x80-\x9f`) — new user input paths must apply equivalent sanitization

## Error Response Sanitization

- Error responses returned via `mcpError()` / `mcpValidationError()` must never include:
  - Stack traces
  - Internal file paths
  - Raw error objects
  - Token values or account identifiers
