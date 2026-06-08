#!/usr/bin/env node
// Refuses to build when the live symlinked repo is on a non-main branch
// or has uncommitted changes. Dev work must use a git worktree.
// Skipped in CI (GitHub Actions) where checkouts are always clean.
const { execSync } = require('child_process');

// CI environments always do clean, correct checkouts — guard not needed there.
if (process.env.CI) process.exit(0);

let branch, dirty;
try {
  branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
} catch {
  // Not a git repo or git unavailable — let the build proceed.
  process.exit(0);
}

if (branch && branch !== 'main') {
  console.error(
    `\nLIVE BUILD GUARD: refusing to build on branch "${branch}".\n` +
    `The live npm-global-linked CLI must only be built from main.\n` +
    `For dev work, use a git worktree:\n\n` +
    `  git worktree add ../fancy-openclaw-linear-skill-${branch} ${branch}\n` +
    `  cd ../fancy-openclaw-linear-skill-${branch} && npm run build\n`
  );
  process.exit(1);
}

if (dirty) {
  console.error(
    `\nLIVE BUILD GUARD: refusing to build with uncommitted changes on main.\n` +
    `The live CLI must only be built from a clean, committed state.\n` +
    `For dev work on main, use a git worktree on a feature branch:\n\n` +
    `  git worktree add ../fancy-openclaw-linear-skill-<branch> -b <branch>\n` +
    `  cd ../fancy-openclaw-linear-skill-<branch> && npm run build\n`
  );
  process.exit(1);
}
