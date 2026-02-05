# Agent self-discovery via --help: what it teaches and what it doesn't

## What --help reveals (agents can learn on their own)
- All available commands with descriptions
- Argument syntax and names
- Optional flags (--full-page, --submit, --clear, --static, etc.)
- Global options (--browser, --session, --headed, --isolated)

```bash
playwright-cli --help                 # All commands
playwright-cli --help screenshot      # Specific command details
playwright-cli --help fill            # Shows --submit flag
playwright-cli --help network         # Shows --static and --clear flags
```

## What --help does NOT reveal (agents need to be told)

### 1. Behavioral quirks
- `tab-new <url>` opens blank, not the URL
- `close` kills session, not just the page
- Refs invalidate after any page change
- "Page URL" header is wrong in multi-tab mode

### 2. Serialization behavior
- eval returns "ref: <Node>" for DOM elements
- What types serialize cleanly vs what doesn't

### 3. Invisible states
- Focus state not shown in snapshots
- Form values not shown in snapshots

### 4. Installation quirks
- PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS env var
- Session cleanup before start

### 5. Output indirection
- console/network return file paths, not content

### 6. Advanced patterns
- Dark mode emulation via run-code
- Response interception via run-code
- Tab-based workflow patterns

## Impact on agent prompt
The prompt should:
1. Point agents to `--help` for syntax discovery
2. Explicitly document only the things --help can't teach
3. Focus on behavioral gotchas, not syntax documentation
