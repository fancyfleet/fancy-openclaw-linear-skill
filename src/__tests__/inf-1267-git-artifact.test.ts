/**
 * INF-1267 — git-state auto-derivation of the `--code-artifact` operand.
 *
 * AC (verbatim, INF-1267 bullet 2): the artifact is auto-derived from the CLI's
 * cwd git state by default (`git branch --show-current` + `git rev-parse HEAD`).
 *
 * AC bullet 3: when git state is unavailable (not a repo / detached HEAD with no
 * branch / no commits) and no `--code-artifact` is given, the caller must get a
 * clear, actionable error — never a partial or empty artifact silently returned.
 *
 * `deriveCodeArtifactFromGit` is the seam `submit` calls to get the default
 * artifact (see inf-1267-submit-code-artifact.test.ts). It is tested in
 * isolation here against mocked `execSync` so this file owns all the git-command
 * edge cases without needing a real repository fixture.
 */

import { execSync } from "node:child_process";
import { deriveCodeArtifactFromGit } from "../git-artifact";

jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

function mockGitState(branchOutput: string | null, shaOutput: string | null): void {
  mockExecSync.mockImplementation(((cmd: string) => {
    const command = String(cmd);
    if (command.includes("branch --show-current")) {
      if (branchOutput === null) throw new Error("fatal: not a git repository (or any of the parent directories): .git");
      return branchOutput;
    }
    if (command.includes("rev-parse HEAD")) {
      if (shaOutput === null) throw new Error("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
      return shaOutput;
    }
    throw new Error(`unexpected git command in test: ${command}`);
  }) as never);
}

describe("deriveCodeArtifactFromGit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("derives {branch, sha} from `git branch --show-current` + `git rev-parse HEAD` (AC2)", () => {
    mockGitState("feature/INF-1267-code-artifact-submit\n", "c81dfe0abc1234567890abcdef1234567890abcd\n");

    expect(deriveCodeArtifactFromGit()).toEqual({
      branch: "feature/INF-1267-code-artifact-submit",
      sha: "c81dfe0abc1234567890abcdef1234567890abcd",
    });
  });

  it("throws a clear, actionable error naming --code-artifact when cwd is not a git repository (AC3)", () => {
    mockGitState(null, null);

    expect(() => deriveCodeArtifactFromGit()).toThrow(/--code-artifact/);
  });

  it("throws when HEAD is detached with no branch name (empty `branch --show-current` output) (AC3)", () => {
    // A detached HEAD prints an empty line, not an error — this is the case a
    // naive "did the command succeed" check would miss and silently return "".
    mockGitState("\n", "c81dfe0\n");

    expect(() => deriveCodeArtifactFromGit()).toThrow(/--code-artifact/);
  });

  it("throws when the repository has no commits yet (`rev-parse HEAD` fails) (AC3)", () => {
    mockGitState("main\n", null);

    expect(() => deriveCodeArtifactFromGit()).toThrow(/--code-artifact/);
  });

  it("never returns a partial artifact: an empty sha with a valid branch still throws (AC3)", () => {
    mockGitState("main\n", "\n");

    expect(() => deriveCodeArtifactFromGit()).toThrow(/--code-artifact/);
  });

  it("trims surrounding whitespace/newlines from both git outputs", () => {
    mockGitState("  main  \n", "  c81dfe0abc1234567890abcdef1234567890abcd  \n");

    expect(deriveCodeArtifactFromGit()).toEqual({
      branch: "main",
      sha: "c81dfe0abc1234567890abcdef1234567890abcd",
    });
  });
});
