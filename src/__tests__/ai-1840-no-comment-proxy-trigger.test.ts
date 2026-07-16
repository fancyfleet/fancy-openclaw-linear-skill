/**
 * AI-1840: validated verb without --comment must not send delegate/assignee fields
 * directly to Linear — those are the proxy's responsibility via applyStateTransition.
 *
 * Bug: `linear validated <id>` (no comment) used to send { delegateId: null,
 * assigneeId: null } in the issueUpdate body. The proxy's Layer 2 intent-path
 * check (checkRawMutationInterception) blocked this as "Direct assignee/delegate
 * changes are blocked", causing a silent exit 1.
 *
 * Fix: for proxy-governed transitions (omitStateId=true) without a comment, the
 * CLI sends an empty {} issueUpdate carrying the intent header as the trigger.
 * The proxy's applyStateTransition handles delegate/assignee clearing atomically.
 */

import { getSelfUser } from "../auth";
import { getComments } from "../boards";
import { addComment, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import { validated } from "../semantic";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
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

jest.mock("../state-machine", () => ({
  ...jest.requireActual("../state-machine"),
  checkCommentRateLimit: jest.fn().mockResolvedValue(null),
  findRecentDuplicate: jest.fn().mockResolvedValue(null),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn(),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn(),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn(),
}));

const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;

const COMMENT_BODY = "Acceptance criteria verified.";

const AC_VALIDATE_LABELS = [
  { id: "label-wf-dev-impl", name: "wf:dev-impl" },
  { id: "label-ac-validate", name: "state:ac-validate" },
];

const DONE_LABELS = [
  { id: "label-wf-dev-impl", name: "wf:dev-impl" },
  { id: "label-done", name: "state:done" },
];

const preIssue: any = {
  id: "issue-1",
  identifier: "AI-1840",
  title: "validated verb without comment blocked by Layer 2",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-review", name: "In Review", type: "started" },
  assignee: { id: "user-igor", name: "Igor (Back End Dev)" },
  delegate: { id: "user-astrid", name: "Astrid (CPO)" },
  labels: AC_VALIDATE_LABELS,
};

// Post-transition shape after the proxy's applyStateTransition clears ownership
// (terminal state → delegate=null).
const doneIssue: any = {
  ...preIssue,
  state: { id: "state-done", name: "Done", type: "completed" },
  assignee: null,
  delegate: null,
  labels: DONE_LABELS,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINEAR_PROXY_URL = "http://localhost:3100/proxy";
  process.env.LINEAR_POST_TRANSITION_VERIFY_DELAY_MS = "0"; // AI-2110: no real sleep in tests
  mockGetIssue.mockResolvedValue(preIssue);
  mockUpdateIssue.mockResolvedValue(doneIssue);
  mockFindSemanticState.mockResolvedValue({
    id: "state-done",
    name: "Done",
    type: "completed",
  } as any);
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-new",
    commentUrl: "https://linear.app/c/new",
    commentCreatedAt: "2026-07-05T20:30:00Z",
    commentBodyLength: COMMENT_BODY.length,
    body: COMMENT_BODY,
  } as any);
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
});

describe("AI-1840 — proxy-governed transition without comment", () => {
  it("sends an empty {} issueUpdate (not delegate/assignee fields)", async () => {
    await validated("AI-1840");

    // The issueUpdate must be empty — NO delegateId:null or assigneeId:null.
    // The proxy's applyStateTransition is the sole atomic writer.
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-1840", {});
  });

  it("does NOT send delegateId or assigneeId in any call", async () => {
    await validated("AI-1840");

    const call = mockUpdateIssue.mock.calls[0];
    const payload = call[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("delegateId");
    expect(payload).not.toHaveProperty("assigneeId");
  });

  it("still succeeds when the proxy applied the transition (label moved to done)", async () => {
    const result = await validated("AI-1840");

    expect(result.state).toBe("Done");
    expect(result.delegate).toBeNull();
    // No comment was posted.
    expect(result.commentPosted).toBe(false);
  });

  it("hard-errors if the proxy did not move the state:* label", async () => {
    // Proxy declined: ticket comes back still in state:ac-validate.
    mockUpdateIssue.mockResolvedValue(preIssue);

    await expect(validated("AI-1840")).rejects.toThrow(/did NOT apply/);
  });

  it("with --comment still uses the comment-trigger path (comment triggers proxy, no issueUpdate)", async () => {
    // With a comment, the comment carries the intent and triggers the transition.
    // The CLI re-fetches instead of sending an issueUpdate.
    mockGetIssue.mockResolvedValueOnce(preIssue).mockResolvedValueOnce(doneIssue);

    const result = await validated("AI-1840", { comment: COMMENT_BODY });

    // No issueUpdate at all when the comment posted successfully — the comment
    // triggered applyStateTransition and the CLI just re-fetches.
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(true);
  });
});

describe("AI-1840 — non-proxy (direct API) mode still writes delegate/assignee", () => {
  it("sends delegateId:null and assigneeId:null in direct mode", async () => {
    delete process.env.LINEAR_PROXY_URL;
    mockGetIssue.mockResolvedValueOnce(preIssue).mockResolvedValueOnce(doneIssue);

    await validated("AI-1840");

    // In direct mode the CLI writes fields directly (no proxy to atomically apply).
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toHaveProperty("delegateId", null);
    expect(payload).toHaveProperty("assigneeId", null);
  });
});
