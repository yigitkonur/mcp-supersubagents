# Where agents derail: observed patterns from testing sessions

## Derailment pattern 1: Using stale refs
**What happens**: Agent takes a snapshot, then does something that changes the page (click, navigate, hover), then tries to use the old refs.
**How to prevent**: Always re-snapshot after any page-changing action. Make this a habit, not an afterthought.

## Derailment pattern 2: Assuming command behavior
**What happens**: Agent assumes `tab-new <url>` navigates, or `close` just closes a tab, or eval handles DOM nodes.
**How to prevent**: When unsure, use `--help <command>` first. The help output is fast and accurate.

## Derailment pattern 3: Checking wrong output for verification
**What happens**: Agent checks "Page URL" in multi-tab mode (wrong), or checks snapshot for form values (not shown), or checks HTTP status for 404 (soft 404 returns 200).
**How to prevent**: Use eval for ground truth. `eval "() => window.location.href"` for URL, `eval "(el) => el.value"` for form values, page content for 404 detection.

## Derailment pattern 4: Not handling unexpected dialogs
**What happens**: Site triggers an alert/confirm. All subsequent commands fail with "does not handle modal state".
**How to prevent**: If a command fails unexpectedly, check for Modal state in the output. Use dialog-accept or dialog-dismiss.

## Derailment pattern 5: Memory-intensive session management
**What happens**: Agent creates a new session/browser for every test scenario instead of using tabs.
**How to prevent**: Use tabs within one session. Only create separate sessions for truly isolated test contexts.

## Derailment pattern 6: Losing session state
**What happens**: Agent uses `close` instead of `tab-close`, destroying the session and losing all cookies/localStorage.
**How to prevent**: Never use `close`. Always use `tab-close <index>`.

## Derailment pattern 7: Overly complex eval when simple command exists
**What happens**: Agent writes complex eval to click an element when `click <ref>` would do.
**How to prevent**: Use CLI commands for common operations. Reserve eval/run-code for things CLI commands can't do.

## Impact on agent prompt
These patterns should inform the gotchas section. Each represents a real failure mode observed during hands-on testing.
