---
applyTo: "**/.github/workflows/**/*.{yml,yaml}"
---

# CI/CD Workflow Review Guidelines

## Security

- Pin actions to full commit SHA, not tags — tags can be re-pointed
- Never expose secrets in logs — use masking for dynamic secrets
- Set `permissions` explicitly with minimum required scope — don't rely on defaults
- `NPM_TOKEN` and `GITHUB_TOKEN` must only appear in `env:` blocks, never in `run:` scripts directly

```yaml
# Avoid — tag can be hijacked
uses: actions/checkout@v4

# Prefer — immutable commit SHA
uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11
```

## Build Pipeline

- The build uses `tsc --noEmitOnError false` — TypeScript errors don't block emit (intentional)
- Build script also copies `.mdx` template files — changes to templates must update copy commands
- `pnpm install --frozen-lockfile` must be used in CI — never `pnpm install` without lockfile flag

## Publish Safety

- The `[skip ci]` check in commit messages prevents publish loops — do not remove
- Version bump and publish are separate steps with guards — preserve the `exists` check
- The `--no-git-checks` flag on publish is required because CI runs on a detached HEAD
