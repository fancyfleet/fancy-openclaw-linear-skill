/**
 * INF-1267 — `linear submit <id> [target]` can supply the
 * `X-Openclaw-Code-Artifact: <branch>@<sha>` header, so an
 * `implementation`/`doing` → `code-review` transition succeeds against a
 * connector enforcing the INF-1060 push-before-claim gate.
 *
 * AC coverage map:
 *   (a) header populated from derived git state by default        -> "derives from git state"
 *   (b) --code-artifact overrides the derived value                -> "explicit --code-artifact overrides"
 *   (c) missing git state + no flag -> clear error, no header sent -> "fails loudly when git state is unavailable"
 *   (4) reuses setProxyCodeArtifact/formatCodeArtifact/parseCodeArtifact,
 *       identical header shape to handoff-work's                   -> "formats the header identically"
 *
 * Scope note: like ai-2479-handoff-code-artifact.test.ts, enforcement of the
 * artifact declaration is connector-side. This file only proves the CLI derives
 * the right value and transmits it (or fails loudly instead of transmitting
 * nothing/garbage) — never that the connector accepts or rejects it.
 */

import { submit } from "../semantic";
import { addComment, getIssue, updateIssue, resolveUserWithHints } from "../issues";
import { getSelfUser } from "../auth";
import { findSemanticState, SEMANTIC_STATE_MAP } from "../states";
import { setProxyCodeArtifact, setProxyIntent, setProxyTarget } from "../client";
import { deriveCodeArtifactFromGit } from "../git-artifact";
import { formatCodeArtifact } from "../artifact";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
  setProxyTarget: jest.fn(),
  setProxyCodeArtifact: jest.fn(),
}));

jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  getSelfUser: jest.fn(),
}));

jest.mock("../issues", () => ({
  ...jest.requireActual("../issues"),
  addComment: jest.fn(),
  findUserByName: jest.fn(),
  resolveUserWithHints: jest.fn(),
  getIssue: jest.fn(),
  updateIssue: jest.fn(),
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn(),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn().mockResolvedValue([]),
}));

// INF-1267: submit's default artifact comes from this seam, not from `submit`
// shelling out to git itself — keeps the git-command edge cases isolated to
// inf-1267-git-artifact.test.ts and lets these tests assert on *wiring* only.
jest.mock("../git-artifact", () => ({
  deriveCodeArtifactFromGit: jest.fn(),
}));

const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockSetProxyCodeArtifact = setProxyCodeArtifact as jest.MockedFunction<typeof setProxyCodeArtifact>;
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;
const mockSetProxyTarget = setProxyTarget as jest.MockedFunction<typeof setProxyTarget>;
const mockDeriveCodeArtifactFromGit = deriveCodeArtifactFromGit as jest.MockedFunction<typeof deriveCodeArtifactFromGit>;

const thinkingState = { id: "state-thinking", name: "In Review", type: "started" };

const baseIssue = {
  id: "issue-1",
  identifier: "INF-1267",
  title: "submit --code-artifact",
  team: { id: "team-inf", key: "INF", name: "Infra" },
  state: { id: "state-doing", name: "In Progress", type: "started" },
  assignee: null,
  delegate: null,
  labels: [],
};

const DERIVED = {
  branch: "feature/INF-1267-code-artifact-submit",
  sha: "c81dfe0abc1234567890abcdef1234567890abcd",
};

const EXPLICIT_ARTIFACT = "feature/other-branch@1234567";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSelfUser.mockResolvedValue({ id: "user-igor", name: "Igor (Back End Dev)", email: "igor@test.com" } as never);
  mockResolveUserWithHints.mockResolvedValue({ id: "user-igor", name: "Igor (Back End Dev)", app: true } as never);
  mockGetIssue.mockResolvedValue(baseIssue as never);
  mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
    if (!(semantic.toLowerCase() in SEMANTIC_STATE_MAP)) {
      throw new Error(`Unknown semantic state "${semantic}"`);
    }
    return thinkingState as never;
  });
  mockUpdateIssue.mockImplementation(async (id: string, input: any) => ({
    ...baseIssue,
    ...input,
  }) as never);
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-uuid",
    commentUrl: "https://linear.app/test/comment/comment-uuid",
    commentCreatedAt: "2026-08-05T18:00:00Z",
    commentBodyLength: 4,
    body: "test",
  } as never);
  mockDeriveCodeArtifactFromGit.mockReturnValue(DERIVED);
});

describe("submit — code-artifact header (INF-1267)", () => {
  it("derives from git state by default and sends the header, cleared afterward (AC2a)", async () => {
    await submit("INF-1267", "Igor (Back End Dev)");

    expect(mockDeriveCodeArtifactFromGit).toHaveBeenCalled();
    expect(mockSetProxyCodeArtifact).toHaveBeenNthCalledWith(1, formatCodeArtifact(DERIVED));
    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
  });

  it("still derives from git state and sends the header when no target is given", async () => {
    await submit("INF-1267");

    expect(mockDeriveCodeArtifactFromGit).toHaveBeenCalled();
    expect(mockSetProxyCodeArtifact).toHaveBeenNthCalledWith(1, formatCodeArtifact(DERIVED));
  });

  it("explicit --code-artifact overrides the derived value and skips git derivation entirely (AC2b)", async () => {
    await submit("INF-1267", "Igor (Back End Dev)", { codeArtifact: EXPLICIT_ARTIFACT });

    expect(mockDeriveCodeArtifactFromGit).not.toHaveBeenCalled();
    expect(mockSetProxyCodeArtifact).toHaveBeenNthCalledWith(1, EXPLICIT_ARTIFACT);
    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
  });

  it("rejects a malformed --code-artifact before any mutation, without touching git derivation (reuses parseCodeArtifact, AC4)", async () => {
    await expect(
      submit("INF-1267", "Igor (Back End Dev)", { codeArtifact: "no-sha-here" })
    ).rejects.toThrow(/--code-artifact must be/);

    expect(mockDeriveCodeArtifactFromGit).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockSetProxyCodeArtifact).not.toHaveBeenCalled();
  });

  it("fails loudly and sends no header when git state is unavailable and no flag is given (AC3/5c)", async () => {
    mockDeriveCodeArtifactFromGit.mockImplementation(() => {
      throw new Error(
        "Unable to derive --code-artifact from git state (not a git repository). Pass --code-artifact <branch>@<sha> explicitly."
      );
    });

    await expect(submit("INF-1267", "Igor (Back End Dev)")).rejects.toThrow(/--code-artifact/);

    // No partial/blind transition: neither the header nor the mutation ever fires.
    expect(mockSetProxyCodeArtifact).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("formats the header identically to handoff-work's '<branch>@<sha>' shape (AC4)", async () => {
    await submit("INF-1267", "Igor (Back End Dev)");

    const sent = mockSetProxyCodeArtifact.mock.calls[0][0];
    expect(sent).toBe(`${DERIVED.branch}@${DERIVED.sha}`);
    expect(sent).toBe(formatCodeArtifact(DERIVED));
  });

  it("clears the artifact header even when the transition throws", async () => {
    mockUpdateIssue.mockRejectedValue(new Error("boom"));

    await expect(submit("INF-1267", "Igor (Back End Dev)")).rejects.toThrow("boom");

    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
  });

  it("does not disturb existing intent/target header behavior", async () => {
    await submit("INF-1267", "Igor (Back End Dev)");

    expect(mockSetProxyIntent).toHaveBeenNthCalledWith(1, "submit");
    expect(mockSetProxyIntent).toHaveBeenLastCalledWith(undefined);
    expect(mockSetProxyTarget).toHaveBeenCalled();
  });
});
