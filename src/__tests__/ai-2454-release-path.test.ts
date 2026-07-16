/**
 * AI-2454: the repo had no release path. Merging a PR published nothing, the
 * version bump was a convention with no enforcement, and there was no way to ask
 * an installed CLI what version it was — so 0.3.9 landed on main, was never
 * tagged, and the fleet silently sat on 0.3.8 with nothing to detect it.
 *
 * These lock in the two halves of the mechanism:
 *   - the release gate, which refuses to publish a tag that disagrees with
 *     package.json or that names a commit off main;
 *   - `linear --version`, which is how an agent answers "is the verb I need
 *     actually installed here?" without reading git log.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pkg from "../../package.json";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-release-tag.js");
const CLI = path.join(REPO_ROOT, "dist", "index.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGate(tag: string | undefined, cwd: string): RunResult {
  const args = tag === undefined ? [GATE] : [GATE, tag];
  try {
    const stdout = execFileSync("node", args, {
      cwd,
      encoding: "utf8",
      // GITHUB_REF_NAME would otherwise supply a tag when none was passed.
      env: { ...process.env, GITHUB_REF_NAME: "" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("AI-2454 — release gate (scripts/check-release-tag.js)", () => {
  // A scratch repo with a real origin/main, built from scratch rather than derived
  // from this checkout: CI clones shallow and has no origin/main ref at all, so a
  // fixture that leans on the ambient repo passes locally and dies in CI. The gate
  // is invoked by absolute path, so it reads the real package.json for the version
  // comparison while running its git checks against this scratch tree.
  let scratch: string;
  let clone: string;

  const git = (cmd: string, cwd: string) =>
    execSync(`git -c user.email=test@example.com -c user.name=test ${cmd}`, { cwd, stdio: "pipe" });

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ai2454-origin-"));
    git("init -q --initial-branch=main .", scratch);
    fs.writeFileSync(path.join(scratch, "file.txt"), "released\n");
    git("add file.txt", scratch);
    git("commit -q -m 'on main'", scratch);

    // Cloning is what produces a genuine origin/main remote-tracking ref.
    clone = fs.mkdtempSync(path.join(os.tmpdir(), "ai2454-clone-"));
    execSync(`git clone -q ${scratch} ${clone}`, { stdio: "pipe" });
  });

  afterAll(() => {
    for (const dir of [scratch, clone]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort — a leaked temp dir must not fail the suite */
      }
    }
  });

  /** The clone sits exactly on origin/main — the state a real release is cut from. */
  const mainWorktree = () => clone;

  it("passes when the tag matches package.json and names a commit on main", () => {
    const res = runGate(`v${pkg.version}`, mainWorktree());

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Release gate OK");
  });

  it("refuses a tag that disagrees with package.json — the forgotten-bump case", () => {
    const res = runGate("v9.9.9", mainWorktree());

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("disagrees with package.json");
    // The message must name the tag it actually wanted, or the operator is back
    // to reconstructing the ritual from git log.
    expect(res.stderr).toContain(`v${pkg.version}`);
  });

  it("refuses a correctly-named tag on a commit that is not on main", () => {
    // Commit into the clone without pushing: that commit is genuinely not an
    // ancestor of origin/main, which is the un-merged tag the gate must catch.
    const stray = fs.mkdtempSync(path.join(os.tmpdir(), "ai2454-stray-"));
    execSync(`git clone -q ${scratch} ${stray}`, { stdio: "pipe" });
    try {
      fs.writeFileSync(path.join(stray, "unmerged.txt"), "never merged to main\n");
      git("add unmerged.txt", stray);
      git("commit -q -m 'unmerged work'", stray);

      const res = runGate(`v${pkg.version}`, stray);

      expect(res.code).toBe(1);
      expect(res.stderr).toContain("not an ancestor of origin/main");
    } finally {
      fs.rmSync(stray, { recursive: true, force: true });
    }
  });

  it("reports a missing origin/main as a checkout problem, not as an off-main tag", () => {
    // CI clones shallow with no origin/main. merge-base fails identically for a
    // missing ref and for un-merged code, so the gate must tell them apart or a
    // checkout problem reads as "someone tagged off main".
    const noOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "ai2454-noorigin-"));
    git("init -q --initial-branch=main .", noOrigin);
    git("commit -q --allow-empty -m 'no remote'", noOrigin);
    try {
      const res = runGate(`v${pkg.version}`, noOrigin);

      expect(res.code).toBe(1);
      expect(res.stderr).toContain("cannot resolve origin/main");
      expect(res.stderr).not.toContain("not an ancestor");
    } finally {
      fs.rmSync(noOrigin, { recursive: true, force: true });
    }
  });

  it("refuses to run with no tag at all rather than guessing one", () => {
    const res = runGate(undefined, mainWorktree());

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no tag given");
  });
});

describe("AI-2454 — installed version is queryable", () => {
  it("prints the package version for --version", () => {
    const out = execFileSync("node", [CLI, "--version"], { encoding: "utf8" }).trim();

    expect(out).toBe(pkg.version);
  });

  it("prints the package version for the -v short flag", () => {
    const out = execFileSync("node", [CLI, "-v"], { encoding: "utf8" }).trim();

    expect(out).toBe(pkg.version);
  });

  it("advertises --version in help, so it is discoverable without reading source", () => {
    const out = execFileSync("node", [CLI, "--help"], { encoding: "utf8" });

    expect(out).toContain("--version");
  });
});

describe("AI-2454 — the version pin no longer blocks a bump", () => {
  // The AI-2003 header test pinned `expect(pkg.version).toBe("0.3.9")`, so every
  // release failed CI until someone hand-edited it (f8046ee is that commit). A
  // release path whose own test suite rejects the version bump is not a path.
  it("has no exact-literal version pin in the header test", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "src", "__tests__", "ai-2003-cli-version-header.test.ts"),
      "utf8"
    );

    expect(src).not.toMatch(/expect\(pkg\.version\)\.toBe\(/);
  });
});
