# 10: Output File Locations & How CLI Stores Data

## The .playwright-cli Directory

All output goes into `.playwright-cli/` in the current working directory:

```
.playwright-cli/
├── page-{timestamp}.yml           # snapshots
├── screenshot-{timestamp}.png     # auto-named screenshots
├── console-{timestamp}.log        # console message logs
├── network-{timestamp}.log        # network request logs
├── traces/
│   ├── trace-{timestamp}.trace    # action trace
│   ├── trace-{timestamp}.network  # network trace
│   └── resources/                 # cached resources
└── {custom-path}/                 # --filename relative paths
    └── your-screenshot.png
```

## How Each Command Returns File Paths

### screenshot
```
### Result
- [Screenshot of viewport](.playwright-cli/playwright-notes/home-desktop.png)
```

### console
```
### Result
- [Console](.playwright-cli/console-2026-02-05T11-37-17-313Z.log)
```

### network
```
### Result
- [Network](.playwright-cli/network-2026-02-05T11-37-18-043Z.log)
```

### snapshot
```
### Snapshot
- [Snapshot](.playwright-cli/page-2026-02-05T11-37-02-613Z.yml)
```

## IMPORTANT: The Agent Must Read These Files

The CLI output only contains the FILE PATH, not the content. To actually see console errors or network failures, the agent must:

```bash
# CLI returns: - [Console](.playwright-cli/console-xxx.log)
# Agent must then read that file to see the actual errors
```

This is a two-step process. The agent should NOT assume the command output contains the diagnostic information.

## --filename Path Resolution

The `--filename` for `screenshot` is relative to `.playwright-cli/`:
```bash
playwright-cli screenshot --filename=evidence/test.png
# Creates: .playwright-cli/evidence/test.png
```

For `run-code` with `page.screenshot()`, the path is relative to the SESSION's cwd:
```bash
playwright-cli run-code 'async page => { await page.screenshot({ path: "full.png", fullPage: true }); }'
# Creates: full.png in cwd (NOT in .playwright-cli/)
```

## Agent Workspace Integration

For the super-tester agent, screenshots should go into the workspace:
```bash
playwright-cli screenshot --filename=../agent-workspace/qa/session/04-evidence/screenshots/home-desktop.png
```
(The `../` escapes .playwright-cli/ to reach the project root)

Or use absolute paths with `run-code`:
```bash
playwright-cli run-code 'async page => { await page.screenshot({ path: "/abs/path/to/evidence/home.png", fullPage: true }); }'
```

## Key Insight for Agent Steering

Tell the agent: "CLI commands return file paths, not content. You must read the log files to see actual errors. Screenshots go to `.playwright-cli/` by default. Use `--filename` with relative paths for organized evidence collection."
