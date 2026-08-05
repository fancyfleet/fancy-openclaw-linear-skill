/**
 * INF-1267 — derive a code-artifact from the cwd's git state.
 *
 * `submit` calls this when no explicit `--code-artifact` flag is given.
 * It shells out to `git branch --show-current` and `git rev-parse HEAD`,
 * trims whitespace, and returns a `{ branch, sha }` object — or throws
 * a clear, actionable error that mentions `--code-artifact` so the caller
 * knows the escape hatch.
 *
 * Edge cases: not a git repo, detached HEAD (empty branch name), no commits
 * (HEAD unresolvable), or empty outputs all throw. The function never returns
 * a partial artifact.
 */

import { execSync } from "node:child_process";

export interface GitArtifact {
  branch: string;
  sha: string;
}

export function deriveCodeArtifactFromGit(): GitArtifact {
  let branch: string;
  let sha: string;

  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Unable to derive --code-artifact from git state (not a git repository). " +
      "Pass --code-artifact <branch>@<sha> explicitly."
    );
  }

  if (!branch) {
    throw new Error(
      "Unable to derive --code-artifact from git state (detached HEAD, no branch name). " +
      "Pass --code-artifact <branch>@<sha> explicitly."
    );
  }

  try {
    sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Unable to derive --code-artifact from git state (no commits in repository). " +
      "Pass --code-artifact <branch>@<sha> explicitly."
    );
  }

  if (!sha) {
    throw new Error(
      "Unable to derive --code-artifact from git state (empty commit sha). " +
      "Pass --code-artifact <branch>@<sha> explicitly."
    );
  }

  return { branch, sha };
}
