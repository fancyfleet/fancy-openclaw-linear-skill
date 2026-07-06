/**
 * AI-1872 — CLI deprecated verb removal.
 *
 * After the dev-impl workflow splits `deployment` + `host-deploy` into
 * `merge` + `deploy`, the state-specific verbs `deploy`, `handoff-host-deploy`,
 * and `host-deployed` are no longer valid commands.  The AC requires these be
 * removed OR replaced with an error that includes "use continue-workflow".
 *
 * AC-to-test mapping:
 *   AC4: Invoking `deploy`, `handoff-host-deploy`, or `host-deployed` either
 *        (a) does not exist as an exported function, or
 *        (b) rejects/throws with a message containing "continue-workflow".
 *
 *   AC4-CLI: The CLI commands `deploy`, `handoff-host-deploy`, `host-deployed`
 *        exit non-zero and their stderr/stdout contains "continue-workflow"
 *        when invoked without a valid workflow context.
 */

import { describe, it, expect } from "@jest/globals";
import { execSync } from "child_process";
import path from "path";
import * as semantic from "../semantic";

const CLI_CWD = path.resolve(__dirname, "../..");

// ── AC4: exported functions throw "use continue-workflow" ─────────────────────

describe("AC4: deprecated verb functions — removed or throw with continue-workflow hint", () => {
  const TARGET_MESSAGE_RE = /continue-workflow/i;

  it("deploy() function is either not exported or throws with 'continue-workflow' hint", async () => {
    const deployFn = (semantic as Record<string, unknown>)["deploy"] as
      ((id: string) => Promise<unknown>) | undefined;

    if (deployFn === undefined) {
      // AC4 option (a): function is simply removed. Pass.
      expect(deployFn).toBeUndefined();
      return;
    }

    // AC4 option (b): function exists but must throw with the hint.
    await expect(deployFn("AI-1872")).rejects.toThrow(TARGET_MESSAGE_RE);
  });

  it("handoffHostDeploy() function is either not exported or throws with 'continue-workflow' hint", async () => {
    const fn = (semantic as Record<string, unknown>)["handoffHostDeploy"] as
      ((id: string) => Promise<unknown>) | undefined;

    if (fn === undefined) {
      expect(fn).toBeUndefined();
      return;
    }

    await expect(fn("AI-1872")).rejects.toThrow(TARGET_MESSAGE_RE);
  });

  it("hostDeployed() function is either not exported or throws with 'continue-workflow' hint", async () => {
    const fn = (semantic as Record<string, unknown>)["hostDeployed"] as
      ((id: string) => Promise<unknown>) | undefined;

    if (fn === undefined) {
      expect(fn).toBeUndefined();
      return;
    }

    await expect(fn("AI-1872")).rejects.toThrow(TARGET_MESSAGE_RE);
  });
});

// ── AC4-CLI: invocable CLI commands print "continue-workflow" and exit non-zero ─

describe("AC4-CLI: deprecated CLI commands removed or error with continue-workflow hint", () => {
  const CONTINUE_WORKFLOW_RE = /continue-workflow/i;

  function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execSync(`node dist/index.js ${args}`, {
        encoding: "utf8",
        cwd: CLI_CWD,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: e.status ?? 1,
      };
    }
  }

  it("'linear deploy <id>' exits non-zero or the command is not registered", () => {
    // Either:
    //   (a) the command is removed — Commander prints "unknown command 'deploy'" → exit 1.
    //   (b) the command is kept but prints an error and exits non-zero.
    // Either way exitCode must not be 0.
    const { exitCode, stdout, stderr } = runCli("deploy AI-1872");
    expect(exitCode).not.toBe(0);
    // If the command IS still registered, it must mention continue-workflow.
    if (!stderr.includes("unknown command") && !stdout.includes("unknown command")) {
      const combined = stdout + stderr;
      expect(combined).toMatch(CONTINUE_WORKFLOW_RE);
    }
  });

  it("'linear handoff-host-deploy <id>' exits non-zero or the command is not registered", () => {
    const { exitCode, stdout, stderr } = runCli("handoff-host-deploy AI-1872");
    expect(exitCode).not.toBe(0);
    if (!stderr.includes("unknown command") && !stdout.includes("unknown command")) {
      const combined = stdout + stderr;
      expect(combined).toMatch(CONTINUE_WORKFLOW_RE);
    }
  });

  it("'linear host-deployed <id>' exits non-zero or the command is not registered", () => {
    const { exitCode, stdout, stderr } = runCli("host-deployed AI-1872");
    expect(exitCode).not.toBe(0);
    if (!stderr.includes("unknown command") && !stdout.includes("unknown command")) {
      const combined = stdout + stderr;
      expect(combined).toMatch(CONTINUE_WORKFLOW_RE);
    }
  });

  it("'linear deploy --help' either does not exist or mentions continue-workflow", () => {
    // If the command is removed from the CLI, --help fails. If kept, the help text
    // must inform agents to use continue-workflow instead.
    const { exitCode, stdout, stderr } = runCli("deploy --help");
    const combined = stdout + stderr;

    if (exitCode === 0) {
      // Command still registered — help text must contain the migration message.
      expect(combined).toMatch(CONTINUE_WORKFLOW_RE);
    } else {
      // Command removed — that's also acceptable (exitCode non-zero = done).
      expect(exitCode).not.toBe(0);
    }
  });
});
