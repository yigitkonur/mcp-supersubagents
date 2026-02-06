# 15: Network Mocking & Route Interception

## When to Mock

- Testing error states (what happens when API returns 500?)
- Testing loading states (slow network)
- Testing without a running backend
- Isolating frontend behavior from backend bugs

## Basic Route Commands

### Block resources (speed up page load)
```bash
playwright-cli route "**/*.jpg" --status=404
playwright-cli route "**/*.png" --status=404
playwright-cli route "**/analytics/**" --status=204
```

### Mock API response
```bash
playwright-cli route "**/api/users" --body='[{"id":1,"name":"Test"}]' --content-type=application/json
```

### List active routes
```bash
playwright-cli route-list
```

### Remove routes
```bash
playwright-cli unroute "**/*.jpg"     # remove specific
playwright-cli unroute                 # remove ALL routes
```

## Advanced Mocking with run-code

### Simulate API failure
```bash
playwright-cli run-code 'async page => {
  await page.route("**/api/data", route => route.abort("internetdisconnected"));
}'
```

### Simulate slow response
```bash
playwright-cli run-code 'async page => {
  await page.route("**/api/data", async route => {
    await new Promise(r => setTimeout(r, 3000));
    route.fulfill({ body: JSON.stringify({ data: "loaded" }), contentType: "application/json" });
  });
}'
```

## Use Case: Testing a 500 Error Page

1. Set up route to return 500
2. Navigate to the page that calls that API
3. Screenshot the error state

```bash
playwright-cli route "**/api/critical" --status=500
playwright-cli open https://example.com/dashboard
playwright-cli screenshot --filename=api-500-error-state.png
playwright-cli unroute
```

## Key Insight for Agent Steering

Network mocking is powerful but niche. Only teach the agent to use it when specifically testing error/edge states. For normal testing, the real network is better evidence.
