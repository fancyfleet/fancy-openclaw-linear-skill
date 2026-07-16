#!/usr/bin/env node
// Release gate: the tag being published must agree with package.json, and must
// name a commit that is already on main.
//
// This is the step that turns "remember to bump the version" into something the
// pipeline enforces. Version bumps here have always been standalone `chore:`
// commits made at release time (see RELEASING.md), which is a convention with no
// teeth: 0.3.9 was bumped on main and never tagged, so every host stayed on
// 0.3.8 and nothing noticed (AI-2454). A tag that disagrees with package.json,
// or that points off main, fails the release instead of publishing a mislabeled
// artifact.
//
// Usage: node scripts/check-release-tag.js <tag>
//   Falls back to GITHUB_REF_NAME when no argument is given (GitHub Actions).

const { execSync } = require("child_process");
const pkg = require("../package.json");

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;

function fail(msg) {
  console.error(`\nRELEASE GATE: ${msg}\n`);
  process.exit(1);
}

if (!tag) {
  fail("no tag given. Pass one as an argument, or run this in Actions where GITHUB_REF_NAME is set.");
}

const expected = `v${pkg.version}`;
if (tag !== expected) {
  fail(
    `tag "${tag}" disagrees with package.json version "${pkg.version}".\n` +
      `The tag for this commit must be "${expected}".\n\n` +
      `Either the version bump was forgotten, or the wrong tag name was pushed.\n` +
      `Fix: delete the tag, land a "chore: bump CLI to <version>" commit on main, then re-tag.\n` +
      `See RELEASING.md.`
  );
}

// A missing origin/main ref makes `merge-base` fail exactly like a genuinely
// off-main tag does. Resolve it separately so a shallow or ref-less checkout
// reports itself instead of masquerading as un-merged code.
try {
  execSync("git rev-parse --verify origin/main", { stdio: "pipe" });
} catch {
  fail(
    "cannot resolve origin/main, so the ancestry check cannot run.\n" +
      "This is a checkout problem, not a bad tag — do not read it as 'the tag is off main'.\n" +
      "In CI, ensure actions/checkout uses fetch-depth: 0 and main is fetched."
  );
}

// A tag can be pushed from any commit, including one that never merged. Publishing
// from an un-merged commit would ship code that main does not contain.
let onMain;
try {
  execSync(`git merge-base --is-ancestor HEAD origin/main`, { stdio: "pipe" });
  onMain = true;
} catch {
  onMain = false;
}

if (!onMain) {
  fail(
    `tag "${tag}" points at a commit that is not an ancestor of origin/main.\n` +
      `Releases publish merged code only. Merge to main first, then tag the merged commit.\n` +
      `See RELEASING.md.`
  );
}

console.log(`Release gate OK: ${tag} matches package.json (${pkg.version}) and is on main.`);
