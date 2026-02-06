# 12: CLI Output Format & How to Parse It

## Standard Output Structure

Every playwright-cli command returns a structured markdown-like output:

### open
```markdown
### Ran Playwright code
` ` `js
await page.goto('https://example.com');
` ` `
### Page
- Page URL: https://example.com/
- Page Title: My Page Title
### Snapshot
- [Snapshot](.playwright-cli/page-{timestamp}.yml)
### Events
- 3 new console entries in ".playwright-cli/console-{timestamp}.log#L1-L13"
```

### screenshot
```markdown
### Result
- [Screenshot of viewport](.playwright-cli/path/to/screenshot.png)
### Ran Playwright code
` ` `js
await page.screenshot({...});
` ` `
```

### eval
```markdown
### Result
{ "fontSize": "50px", "color": "rgb(0,0,0)" }
### Ran Playwright code
` ` `js
await page.evaluate('...');
` ` `
```

### Error case
```markdown
### Error
Error: browserType.launchPersistentContext: Chromium distribution 'chrome' is not found
```

## The "Events" Section Is Key

After many commands, you'll see:
```
### Events
- 8 new console entries in ".playwright-cli/console-xxx.log#L14-L23"
```

This tells you there are NEW console messages since the last check. The `#L14-L23` is a line range hint. This is passive — the agent should proactively check `console error` when it sees events accumulating.

## The Generated Code Section

Every command shows the Playwright code it generated:
```
### Ran Playwright code
` ` `js
await page.getByRole('heading', { name: 'Title' }).screenshot({...});
` ` `
```

This is useful for:
1. Understanding how refs map to Playwright locators
2. Learning the correct Playwright API syntax
3. Generating test code from the agent's exploration

## Error Output Has No "###" Prefix Sometimes

Errors from the Playwright engine come as plain text:
```
SyntaxError: Invalid or unexpected token
```

While CLI-level errors have the `### Error` prefix. The agent should check for both.

## Key Insight for Agent Steering

Tell the agent: "Every CLI command returns structured output with ### headers. The `### Result` section has your data. The `### Events` section warns about new console messages. File paths in brackets like `[Console](path)` must be read separately."
