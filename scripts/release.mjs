#!/usr/bin/env node
/**
 * release.mjs — bump patch version, build, publish to npm, commit, and push.
 *
 * Usage:
 *   pnpm release          # patch bump (default)
 *   pnpm release minor    # minor bump
 *   pnpm release major    # major bump
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const bump = process.argv[2] || 'patch';

if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Invalid bump type: "${bump}". Use: patch | minor | major`);
  process.exit(1);
}

const run = (cmd) => {
  console.error(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: resolve(__dirname, '..') });
};

// 1. Read current version
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

// 2. Compute next version
let next;
if (bump === 'major') next = `${major + 1}.0.0`;
else if (bump === 'minor') next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

// 3. Write new version
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.error(`Bumped ${pkg.name} ${major}.${minor}.${patch} → ${next}`);

// 4. Build
run('pnpm build');

// 5. Publish
run('npm publish');

// 6. Stage all tracked changes + package.json, commit & push
run('git add -u');
run('git add package.json');
run(`git commit -m "chore: release v${next}"`);
run('git push origin main');

console.error(`\n✅ Released ${pkg.name}@${next}`);
