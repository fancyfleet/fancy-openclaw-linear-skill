/**
 * AI-2490: CLI surface for `issue-move-team --state <name>`.
 *
 * The unit tests in ai-2490-move-issue-team-state.test.ts lock the behavior of
 * the `moveIssueTeam` seam, but they cannot prove the flag is actually wired to
 * the command — commander rejects unregistered options during parse, long before
 * any seam is reached. That wiring is a separate AC ("Accept `--state <name>` on
 * `issue-move-team`") and needs its own assertion at the CLI boundary.
 *
 * These tests only exercise ARG PARSING, which commander resolves before the
 * action closure runs, so nothing here touches the network. This matches the
 * existing spawn-based tests (error-messages, ai-1872-deprecated-verbs,
 * deprecated-hidden), and CI builds before it tests.
 */

import path from "node:path";
import { spawn } from "child_process";

const repoRoot = path.resolve(__dirname, "../..");

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], {
      cwd: repoRoot,
      // A syntactically valid but non-functional key: parse-level failures resolve
      // before any request, and anything that reaches the API fails on auth rather
      // than hanging.
      env: { ...process.env, LINEAR_API_KEY: "test-key", LINEAR_PROXY_URL: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ stdout, stderr: String(error), code: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

describe("AI-2490 AC3: issue-move-team --state is registered on the command", () => {
  test("--state is listed in the command's help output", async () => {
    const { stdout, code } = await run(["issue-move-team", "--help"]);

    expect(code).toBe(0);
    expect(stdout).toContain("--state");
  });

  test("--state is not rejected as an unknown option", async () => {
    const { stderr } = await run(["issue-move-team", "AI-1", "INF", "--state", "To Do"]);

    // Asserting on the ABSENCE of a parse error, not on success: with a dummy key
    // the command legitimately fails later at the API. What must not happen is
    // commander refusing the flag outright — which is exactly today's behavior,
    // and what makes this test red.
    expect(stderr).not.toMatch(/unknown option/i);
  });
});
