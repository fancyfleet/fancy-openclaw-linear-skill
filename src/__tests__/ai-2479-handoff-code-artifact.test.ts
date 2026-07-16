/**
 * AI-2479 — `handoff-work --code-artifact` / `--substitution-reason`.
 *
 * Scope note: enforcement is connector-side, deliberately. The CLI is the
 * component being bypassed, so nothing asserted here is a security control —
 * these tests cover that the declaration is RECORDED (in the comment, for the
 * timeline) and TRANSMITTED (as a header, for the proxy), on both handoff paths.
 *
 * The load-bearing test in this file is "never sets a proxy intent": see the
 * comment on that test.
 */

import { handoffWork } from "../semantic";
import { addComment, getIssue, updateIssue, resolveUserWithHints } from "../issues";
import { getSelfUser } from "../auth";
import { findSemanticState } from "../states";
import { setProxyIntent, setProxyCodeArtifact, setProxySubstitutionReason } from "../client";
import { parseArtifactMarkers } from "../artifact";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
  setProxyTarget: jest.fn(),
  setProxyCodeArtifact: jest.fn(),
  setProxySubstitutionReason: jest.fn(),
  setProxyCommentSatisfiedBy: jest.fn(),
}));

jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  getSelfUser: jest.fn(),
}));

jest.mock("../issues", () => ({
  addComment: jest.fn(),
  findUserByName: jest.fn(),
  resolveUserWithHints: jest.fn(),
  getIssue: jest.fn(),
  updateIssue: jest.fn(),
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findStateByName: jest.fn(),
  findSemanticState: jest.fn(),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn().mockResolvedValue([]),
}));

const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;
const mockSetProxyCodeArtifact = setProxyCodeArtifact as jest.MockedFunction<typeof setProxyCodeArtifact>;
const mockSetProxySubstitutionReason = setProxySubstitutionReason as jest.MockedFunction<typeof setProxySubstitutionReason>;

const TEAM = { id: "team-ai", key: "AI", name: "AI Systems" };
const AI = { id: "user-ai", name: "Ai", app: true };
const SELF = { id: "user-igor", name: "Igor (Back End Dev)", app: true };
const TODO = { id: "s-todo", name: "To Do", type: "unstarted" };

const ARTIFACT = "feature/AI-2476-gate@b777e17";

/** A plain ad-hoc ticket — no `state:*` label ⇒ the generic handoff path. */
const genericIssue = {
  id: "issue-1",
  identifier: "AI-2479",
  title: "Test ticket",
  team: TEAM,
  state: { id: "s-doing", name: "In Progress", type: "started" },
  labels: [],
};

/** A live dev-impl ticket — has a `state:*` label ⇒ the owner-change path. */
const devImplIssue = {
  ...genericIssue,
  labels: [{ name: "state:implementation" }],
};

/** The body handed to addComment, which is where the marker must land. */
function postedBody(): string {
  expect(mockAddComment).toHaveBeenCalled();
  return mockAddComment.mock.calls[0][1] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSelfUser.mockResolvedValue(SELF);
  // The delegate must resolve to an app user: requireAppUserDelegate rejects a
  // human before the comment posts, which would mask everything under test.
  mockResolveUserWithHints.mockResolvedValue(AI as never);
  mockFindSemanticState.mockResolvedValue(TODO);
  // executeTransition verifies the delegate actually persisted after the write,
  // so the post-update read must reflect it.
  mockUpdateIssue.mockResolvedValue({ ...genericIssue, delegate: AI } as never);
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-uuid",
    commentUrl: "https://linear.app/test/comment/comment-uuid",
    commentCreatedAt: "2026-07-16T21:00:00Z",
    commentBodyLength: 10,
    body: "x",
  } as never);
  mockGetIssue.mockResolvedValue(genericIssue as never);
});

describe("handoff-work --code-artifact — recording the declaration", () => {
  it("appends a parseable marker to the handoff comment, addressed to the recipient", async () => {
    await handoffWork("AI-2479", "Ai", { comment: "Ready for review.", codeArtifact: ARTIFACT });

    const body = postedBody();
    expect(body).toContain("Ready for review.");
    // `to` is the resolved Linear user id of the agent being handed the work —
    // the party that owes a disclosure at their next handoff. The connector
    // fires on that agent and nobody else; without an address, the guard blocks
    // uninvolved third parties (Ai's AI-2479 refusal, AC4).
    expect(parseArtifactMarkers(body)).toEqual([
      { branch: "feature/AI-2476-gate", sha: "b777e17", to: "user-ai" },
    ]);
  });

  it("addresses the marker to the delegate named on THIS handoff, not a fixed value", async () => {
    // Guards the wiring rather than the shape: a marker hard-coded to one
    // recipient, or built from the caller instead of the delegate, would pass
    // the test above and silently mis-address every real handoff.
    const HANZO = { id: "user-hanzo", name: "Hanzo", app: true };
    mockResolveUserWithHints.mockResolvedValue(HANZO as never);
    // executeTransition verifies the delegate persisted, so the post-update read
    // has to reflect the delegate this handoff actually names.
    mockUpdateIssue.mockResolvedValue({ ...genericIssue, delegate: HANZO } as never);

    await handoffWork("AI-2479", "Hanzo", { comment: "Merging.", codeArtifact: ARTIFACT });

    expect(parseArtifactMarkers(postedBody())[0]?.to).toBe("user-hanzo");
  });

  it("records the marker on the dev-impl owner-change path too", async () => {
    // Regression guard: handoffWork has TWO executeTransition call sites and a
    // live wf:dev-impl ticket takes the other one. Recording on only the generic
    // path would leave every governed handoff — the ones this ticket is about —
    // silently unrecorded.
    mockGetIssue.mockResolvedValue(devImplIssue as never);

    await handoffWork("AI-2479", "Ai", { comment: "Ready for review.", codeArtifact: ARTIFACT });

    expect(parseArtifactMarkers(postedBody())).toHaveLength(1);
  });

  it("synthesises a body naming the artifact when no comment is given", async () => {
    await handoffWork("AI-2479", "Ai", { codeArtifact: ARTIFACT });

    const body = postedBody();
    expect(body).toContain(ARTIFACT);
    expect(parseArtifactMarkers(body)).toHaveLength(1);
  });

  it("posts no marker when no artifact is declared", async () => {
    await handoffWork("AI-2479", "Ai", { comment: "Ready for review." });

    expect(parseArtifactMarkers(postedBody())).toEqual([]);
  });

  it("keeps the marker out of the rendered text a human reads", async () => {
    await handoffWork("AI-2479", "Ai", { comment: "Ready for review.", codeArtifact: ARTIFACT });

    // An HTML comment renders as nothing in Linear, so the human-visible body is
    // unchanged by the record.
    const visible = postedBody().replace(/<!--[\s\S]*?-->/g, "").trim();
    expect(visible).toBe("Ready for review.");
  });
});

describe("handoff-work --code-artifact — transmitting the declaration", () => {
  it("sets the artifact header and clears it afterwards", async () => {
    await handoffWork("AI-2479", "Ai", { comment: "c", codeArtifact: ARTIFACT });

    expect(mockSetProxyCodeArtifact).toHaveBeenNthCalledWith(1, ARTIFACT);
    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
  });

  it("sets the substitution reason alongside the artifact", async () => {
    await handoffWork("AI-2479", "Ai", {
      comment: "c",
      codeArtifact: ARTIFACT,
      substitutionReason: "implementer's branch was force-pushed — rebased onto main",
    });

    expect(mockSetProxySubstitutionReason).toHaveBeenNthCalledWith(
      1,
      "implementer's branch was force-pushed — rebased onto main"
    );
    expect(mockSetProxySubstitutionReason).toHaveBeenLastCalledWith(undefined);
  });

  it("clears the artifact header even when the transition throws", async () => {
    // A leaked module-level header would attach to the NEXT command's mutations.
    mockUpdateIssue.mockRejectedValue(new Error("boom"));

    await expect(handoffWork("AI-2479", "Ai", { comment: "c", codeArtifact: ARTIFACT })).rejects.toThrow("boom");

    expect(mockSetProxyCodeArtifact).toHaveBeenLastCalledWith(undefined);
    expect(mockSetProxySubstitutionReason).toHaveBeenLastCalledWith(undefined);
  });

  it("sets no artifact header when no artifact is declared", async () => {
    await handoffWork("AI-2479", "Ai", { comment: "c" });

    expect(mockSetProxyCodeArtifact).not.toHaveBeenCalledWith(ARTIFACT);
  });
});

describe("handoff-work — never sets a proxy intent", () => {
  // THE load-bearing test in this file, and the reason it exists:
  //
  // Every other semantic verb sets an intent, so making handoff-work "match its
  // siblings" reads as an obvious tidy-up. It is fleet-breaking. No workflow def
  // declares handoff-work as a transition, and the connector hard-refuses an
  // intent no transition declares ("'X' is not a legal command in state 'Y'") —
  // so setting one strands EVERY handoff on EVERY wf:* ticket simultaneously.
  // handoff-work is intent-free by design and is governed instead by the
  // connector's raw delegate-change interception (AI-1535 / AI-1835).
  //
  // If this test ever goes red, the fix is to delete the setProxyIntent call,
  // not to update the assertion.
  it.each([
    ["plain", {}],
    ["with an artifact", { codeArtifact: ARTIFACT }],
    ["with a review handoff", { reviewHandoff: true }],
  ])("sets no intent (%s)", async (_label, extra) => {
    await handoffWork("AI-2479", "Ai", { comment: "c", ...extra });

    expect(mockSetProxyIntent).not.toHaveBeenCalled();
  });

  it("sets no intent on the dev-impl owner-change path", async () => {
    mockGetIssue.mockResolvedValue(devImplIssue as never);

    await handoffWork("AI-2479", "Ai", { comment: "c", codeArtifact: ARTIFACT });

    expect(mockSetProxyIntent).not.toHaveBeenCalled();
  });
});

describe("handoff-work --code-artifact — operand validation fails inertly", () => {
  it("rejects a malformed artifact before any mutation", async () => {
    await expect(
      handoffWork("AI-2479", "Ai", { comment: "c", codeArtifact: "feature/no-sha" })
    ).rejects.toThrow(/--code-artifact must be/);

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockSetProxyCodeArtifact).not.toHaveBeenCalled();
  });

  it("rejects --substitution-reason without --code-artifact", async () => {
    await expect(
      handoffWork("AI-2479", "Ai", { comment: "c", substitutionReason: "because" })
    ).rejects.toThrow(/requires --code-artifact/);

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});
