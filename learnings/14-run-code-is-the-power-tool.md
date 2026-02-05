# run-code gives full Playwright page API — the agent's power tool

## What run-code does
```bash
playwright-cli run-code '<code>'
```
The code is a function that receives the Playwright `page` object. This gives access to EVERYTHING Playwright can do, not just what the CLI exposes as commands.

## Things only run-code can do

### Response interception (HTTP status, headers, body)
```bash
run-code 'async (page) => {
  const resp = await page.goto("https://example.com");
  return {
    status: resp.status(),
    headers: Object.fromEntries(Object.entries(resp.headers()))
  };
}'
```

### API call monitoring during navigation
```bash
run-code 'async (page) => {
  let calls = [];
  page.on("response", r => {
    if (r.url().includes("api")) calls.push({ url: r.url(), status: r.status() });
  });
  await page.reload();
  await page.waitForTimeout(2000);
  return calls;
}'
```

### Dark mode emulation
```bash
run-code 'async (page) => {
  await page.emulateMedia({ colorScheme: "dark" });
}'
```

### Wait for specific conditions
```bash
run-code 'async (page) => {
  await page.waitForSelector(".loaded-indicator");
  return "ready";
}'
```

### Cookie manipulation
```bash
run-code 'async (page) => {
  const context = page.context();
  await context.addCookies([{ name: "test", value: "123", url: "https://example.com" }]);
  return "cookie set";
}'
```

## Quote escaping rules
Single quotes for outer, double quotes for inner:
```bash
# GOOD:
run-code 'async (page) => { return "hello"; }'

# BAD (shell eats the quotes):
run-code "async (page) => { return 'hello'; }"
```

## Impact on agent prompt
`run-code` is the escape hatch for anything the CLI commands can't do. Agents should know it exists for advanced scenarios. But for common operations (click, fill, screenshot, navigate), use the dedicated CLI commands — they're simpler and less error-prone.
