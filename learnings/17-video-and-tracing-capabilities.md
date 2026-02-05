# Video recording and tracing: what they produce and when to use them

## Video recording
```bash
playwright-cli video-start    # Start recording
# ... do stuff ...
playwright-cli video-stop     # Stop and save
# Result: .playwright-cli/video-2026-02-05T11-57-26-714Z.webm (~1.4MB for short session)
```

### Limitations for LLM agents
- Output is .webm video — most LLMs can't process video directly
- Useful for: human review, bug reports, sharing with stakeholders
- NOT useful for: agent self-analysis

### When agents should use video
- When the user explicitly asks for a recording
- When documenting a complex bug reproduction for humans
- When creating demo/walkthrough material

### Agent-friendly alternative
Instead of video, agents should take **screenshots at key moments** and write text descriptions. This creates an LLM-readable audit trail:
```bash
screenshot --filename=step1-before-click.png
# "[step 1] Page shows login form with email/password fields"
click e15   # Login button
screenshot --filename=step2-after-click.png
# "[step 2] Redirected to dashboard, showing welcome message"
```

## Tracing
```bash
playwright-cli tracing-start
# ... do stuff ...
playwright-cli tracing-stop
# Result: .playwright-cli/traces/trace-*.trace (action log)
#         .playwright-cli/traces/trace-*.network (network trace)
#         .playwright-cli/traces/resources/ (captured resources)
```

### When to use tracing
- Performance debugging (detailed action timeline)
- Network request analysis
- Can be opened in Playwright Trace Viewer for visual debugging

### Note about trace file location
Trace files are in `.playwright-cli/traces/` relative to where the CLI daemon runs. In testing, the files weren't always accessible from CWD.

## Impact on agent prompt
Video: mention it exists, note it's for human consumption not agent analysis. Agents should prefer screenshots + text notes.
Tracing: mention for advanced debugging. Mostly useful when the user needs deep performance analysis.
