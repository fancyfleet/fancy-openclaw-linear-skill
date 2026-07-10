/**
 * AI-2053: a governed verb carrying a comment must still write the issue when
 * there is no proxy.
 *
 * Bug: `commentTriggersProxy` was derived from `config.omitStateId && body`
 * alone, without checking `LINEAR_PROXY_URL`. In direct-API mode (no proxy —
 * how the test suite and any non-proxied CLI invocation run) a governed verb
 * carrying a comment therefore set `commentTriggersProxy = true`, posted its
 * comment, and then skipped the `issueUpdate` entirely. The CLI deferred to a
 * proxy that was not there, so nothing was written and the command still
 * exited 0.
 *
 * Fix: `commentTriggersProxy` is now derived from `isProxyGoverned`, which
 * requires `LINEAR_PROXY_URL`. With no proxy the CLI is the only writer and
 * must perform the update itself.
 *
 * These tests pin BOTH sides of the branch so the two modes can never collapse
 * into each other again:
 *   - direct-API mode → comment posted AND issueUpdate performed
 *   - proxy mode      → comment posted, issueUpdate skipped (comment is the trigger)
 */

import { getSelfUser } from "../auth";
import { addComment, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import { requestChanges } from "../semantic";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
  setProxyTarget: jest.fn(),
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

jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn(),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn().mockResolvedValue([]),
}));

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;

const COMMENT_BODY = "Please address the failing assertions in the parser.";
const TARGET = "Igor (Back End Dev)";

const codeReviewIssue: any = {
  id: "issue-1",
  identifier: "AI-2053",
  title: "governed verb with a comment in direct-API mode",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-review", name: "In Review", type: "started" },
  assignee: null,
  delegate: null,
  labels: [
    { id: "label-wf-dev-impl", name: "wf:dev-impl" },
    { id: "label-code-review", name: "state:code-review" },
  ],
};

// Shape after the transition applies: state:code-review → state:implementation.
const implementationIssue: any = {
  ...codeReviewIssue,
  state: { id: "state-doing", name: "In Progress", type: "started" },
  labels: [
    { id: "label-wf-dev-impl", name: "wf:dev-impl" },
    { id: "label-implementation", name: "state:implementation" },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINEAR_PROXY_URL;
  mockGetSelfUser.mockResolvedValue({ id: "user-igor", name: TARGET, email: "igor@test.com" } as any);
  mockResolveUserWithHints.mockResolvedValue({ id: "user-igor", name: TARGET } as any);
  mockGetIssue.mockResolvedValue(codeReviewIssue);
  mockFindSemanticState.mockResolvedValue({ id: "state-doing", name: "In Progress", type: "started" } as any);
  // The real updateIssue re-fetches, so a delegateId in the payload comes back
  // materialized. Step 11 hard-errors when the delegate write did not persist.
  mockUpdateIssue.mockImplementation(async (_id: string, input: any) => ({
    ...implementationIssue,
    ...(input.delegateId !== undefined
      ? { delegate: input.delegateId ? { id: input.delegateId, name: `user:${input.delegateId}` } : null }
      : {}),
  })) as any;
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-new",
    commentUrl: "https://linear.app/c/new",
    commentCreatedAt: "2026-07-10T11:00:00Z",
    commentBodyLength: COMMENT_BODY.length,
    body: COMMENT_BODY,
  } as any);
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
});

describe("AI-2053 — governed verb + comment, direct-API mode (no LINEAR_PROXY_URL)", () => {
  it("writes the issue rather than deferring to an absent proxy", async () => {
    // --target makes the write observable: delegateId is the one workflow field
    // the CLI still owns in direct-API mode (state and labels are the proxy's).
    const result = await requestChanges("AI-2053", { comment: COMMENT_BODY, target: TARGET });

    // The regression: this call used to be skipped entirely, so the delegate was
    // never written and the CLI still exited 0.
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-2053",
      expect.objectContaining({ delegateId: "user-igor" }),
    );

    // The comment still lands — the fix must not trade the write for the comment.
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddComment).toHaveBeenCalledWith("AI-2053", COMMENT_BODY);
    expect(result.commentPosted).toBe(true);
  });

  it("still omits stateId — the native column is never written by a governed verb", async () => {
    await requestChanges("AI-2053", { comment: COMMENT_BODY, target: TARGET });

    const [, payload] = mockUpdateIssue.mock.calls[0] as [string, any];
    expect(payload.stateId).toBeUndefined();
  });

  it("performs the issueUpdate even with no --target to carry", async () => {
    // Without a target there is no field the CLI owns, so the payload is empty —
    // but the update must still fire. Skipping it is what stranded the transition.
    await requestChanges("AI-2053", { comment: COMMENT_BODY });

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockAddComment).toHaveBeenCalledTimes(1);
  });

  it("does not post the comment twice", async () => {
    await requestChanges("AI-2053", { comment: COMMENT_BODY, target: TARGET });
    expect(mockAddComment).toHaveBeenCalledTimes(1);
  });
});

describe("AI-2053 — governed verb + comment, proxy mode (LINEAR_PROXY_URL set)", () => {
  beforeEach(() => {
    process.env.LINEAR_PROXY_URL = "http://localhost:3100/proxy";
    // The proxy's applyStateTransition performs the write; the CLI re-fetches to
    // observe the post-transition state (AI-1709).
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValueOnce(codeReviewIssue).mockResolvedValue(implementationIssue);
  });

  it("skips the issueUpdate — the comment carries the intent header and is the trigger", async () => {
    await requestChanges("AI-2053", { comment: COMMENT_BODY });

    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});
