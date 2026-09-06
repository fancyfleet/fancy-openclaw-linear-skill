/**
 * LSG-6 (2026-08-23) — `linear continue-workflow <id> [target] --code-artifact` sends the
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

import { continueWorkflow } from "../semantic";
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
  // Return the issue with delegate populated so executeTransition's post-mutation
  // delegate-verification (AI-1769 AC3) sees the expected state.
  mockGetIssue.mockResolvedValue({ ...baseIssue, delegate: { id: "user-igor", name: "Igor (Back End Dev)" } } as never);
  mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
    if (!(semantic.toLowerCase() in SEMANTIC_STATE_MAP)) {
      throw new Error(`Unknown semantic state "${semantic}"`);
    }
    return thinkingState as never;
  });
  mockUpdateIssue.mockImplementation(async (id: string, input: any) => {
    const result: any = { ...baseIssue, ...input };
    // Simulate Linear API: delegateId input becomes delegate object on output.
    if (input.delegateId && !result.delegate) {
      result.delegate = { id: input.delegateId, name: "Igor (Back End Dev)" };
    }
    return result as any;
  });
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

describe("continue-workflow — explicit --code-artifact (LSG-6)", () => {
  it("sends the X-Openclaw-Code-Artifact header when the flag is given, cleared afterward", async () => {
    await continueWorkflow("INF-1267", "Igor (Back End Dev)", { comment: "Submitting", codeArtifact: EXPLICIT_ARTIFACT });

    expect(mockSetProxyCodeArtifact).toHaveBeenNthCalledWith(1, EXPLICIT_ARTIFACT);
    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
    expect(mockSetProxyIntent).toHaveBeenNthCalledWith(1, "continue-workflow");
  });

  it("appends the artifact marker to the posted comment so the record lives on the ticket", async () => {
    await continueWorkflow("INF-1267", "Igor (Back End Dev)", { comment: "Submitting", codeArtifact: EXPLICIT_ARTIFACT });

    const posted = String(mockAddComment.mock.calls[0]?.[1] ?? "");
    expect(posted.startsWith("Submitting")).toBe(true);
    expect(posted).toContain("artifact-disclosure:");
    expect(posted).toContain('"branch":"feature/other-branch","sha":"1234567","to":"user-igor"');
  });

  it("never derives from git — the generic verb is also run from reviewer/deployer cwds", async () => {
    await continueWorkflow("INF-1267", "Igor (Back End Dev)", { comment: "Approving" });

    expect(mockDeriveCodeArtifactFromGit).not.toHaveBeenCalled();
    expect(mockSetProxyCodeArtifact).not.toHaveBeenCalledWith(expect.stringContaining("@"));
  });

  it("rejects a malformed --code-artifact before any mutation", async () => {
    await expect(
      continueWorkflow("INF-1267", "Igor (Back End Dev)", { comment: "x", codeArtifact: "no-sha-here" })
    ).rejects.toThrow(/--code-artifact must be/);

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("clears the artifact header even when the transition throws", async () => {
    mockUpdateIssue.mockRejectedValueOnce(new Error("boom"));
    await expect(
      continueWorkflow("INF-1267", "Igor (Back End Dev)", { comment: "x", codeArtifact: EXPLICIT_ARTIFACT })
    ).rejects.toThrow("boom");
    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
  });
});
