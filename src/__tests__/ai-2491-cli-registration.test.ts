/**
 * AI-2491 — AC 1 & AC 2, command surface: the ACs specify `linear read-state <ID>`
 * and `linear read-last-comment <ID>` — CLI commands, not just library functions.
 *
 * The sibling suites (ai-2491-read-state / ai-2491-read-last-comment) prove the
 * behavior of the exported functions. They would all still pass if the implementer
 * wrote `readState` and `readLastComment` in src/issues.ts and never wired them
 * into src/index.ts — leaving the AC unmet and the agent-facing command missing.
 * This suite closes that gap.
 *
 * Convention follows deprecated-hidden.test.ts: shell out to the built CLI and
 * read --help. Requires `npm run build` first — same precondition that suite
 * already carries. (The prebuild guard refuses non-main branches locally; it
 * no-ops under CI=1, which is how these run in CI.)
 */

import { execSync } from "child_process";

const REPO_ROOT = __dirname + "/../..";

function runCli(args: string): string {
  return execSync(`node dist/index.js ${args}`, {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
}

describe("AI-2491: read commands are registered on the CLI (AC 1, AC 2)", () => {
  it("registers read-state as a top-level command", () => {
    const help = runCli("--help");
    expect(help).toMatch(/^\s+read-state\b/m);
  });

  it("registers read-last-comment as a top-level command", () => {
    const help = runCli("--help");
    expect(help).toMatch(/^\s+read-last-comment\b/m);
  });

  it("read-state takes an issue ID argument", () => {
    const help = runCli("read-state --help");
    expect(help).toContain("Usage: linear read-state");
    // Commander renders a required arg as <name>. The AC signature is
    // `read-state <ID>` — assert on the shape, not the operand's spelling.
    expect(help).toMatch(/read-state\s+<[^>]+>/);
  });

  it("read-last-comment takes an issue ID argument", () => {
    const help = runCli("read-last-comment --help");
    expect(help).toContain("Usage: linear read-last-comment");
    expect(help).toMatch(/read-last-comment\s+<[^>]+>/);
  });

  it("neither command is hidden from --help — agents must be able to discover them", () => {
    // The whole point is displacing the observe-issue habit. A command an agent
    // cannot find in --help does not displace anything.
    const help = runCli("--help");
    expect(help).toMatch(/read-state/);
    expect(help).toMatch(/read-last-comment/);
  });
});
