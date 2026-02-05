# snapshot --filename saves the accessibility tree to a file

## What happened
```bash
playwright-cli snapshot --filename=saved-snapshot.md
# Result: snapshot saved to .playwright-cli/saved-snapshot.md
```

## Why this matters
Without `--filename`, snapshots are saved with auto-generated timestamps (`page-*.yml`). With `--filename`, you get a predictable name that's easy to reference later.

## Use cases for agents
1. **Baseline comparison**: Save initial snapshot, make changes, compare
2. **Cross-viewport comparison**: Save desktop snapshot as `desktop-tree.yml`, mobile as `mobile-tree.yml`
3. **Evidence collection**: Save snapshots with meaningful names for the test report
4. **Debugging**: Save snapshot at failure point for analysis

## Note
The snapshot is always in YAML format regardless of the filename extension.
