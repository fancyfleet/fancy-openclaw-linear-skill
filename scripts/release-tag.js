#!/usr/bin/env node
// Cuts a release: tags the current merged main with the version in package.json
// and pushes the tag, which is what triggers .github/workflows/release.yml.
//
// The tag name is derived from package.json rather than typed, so the release
// cannot be started under a name that disagrees with what will be published.
// Everything below is a refusal to publish something other than clean, merged main.
//
// Usage: npm run release:tag [-- --dry-run]

const { execSync } = require("child_process");
const pkg = require("../package.json");

const dryRun = process.argv.includes("--dry-run");
const tag = `v${pkg.version}`;

function fail(msg) {
  console.error(`\nRELEASE: ${msg}\n`);
  process.exit(1);
}

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

const branch = git("branch --show-current");
if (branch !== "main") {
  fail(`refusing to tag from branch "${branch}". Releases are cut from main.`);
}

if (git("status --porcelain")) {
  fail("refusing to tag with uncommitted changes. The tag must name exactly what was reviewed and merged.");
}

execSync("git fetch origin main --tags", { stdio: "inherit" });

if (git("rev-parse HEAD") !== git("rev-parse origin/main")) {
  fail("local main is not level with origin/main. Pull (or push) first — the tag must name a commit that is on the remote.");
}

const existing = git("tag --list " + tag);
if (existing) {
  fail(
    `tag ${tag} already exists.\n` +
      `A released version is never re-pointed — consumers may already have it.\n` +
      `Land a "chore: bump CLI to <next version>" commit on main and release that instead.\n` +
      `See RELEASING.md.`
  );
}

if (dryRun) {
  console.log(`Dry run: would tag ${git("rev-parse --short HEAD")} as ${tag} and push it to origin.`);
  process.exit(0);
}

execSync(`git tag -a ${tag} -m "Release ${tag}"`, { stdio: "inherit" });
execSync(`git push origin ${tag}`, { stdio: "inherit" });

console.log(`\nTagged and pushed ${tag}. The Release workflow publishes the artifact.`);
console.log(`Verify: gh release view ${tag} --repo fancyfleet/fancy-openclaw-linear-skill`);
