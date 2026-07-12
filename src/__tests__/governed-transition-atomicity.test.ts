/**
 * AI-1769: governed workflow transitions must be atomic from the agent's
 * point of view — status + workflow label + delegate either all persist or
 * none, with a non-zero exit and an explicit report when they don't.
 *
 * Replays the AI-1767 stranding (2026-07-04 ~07:21 UTC): a prior blocked
 * handoff-work attempt had already posted the failure comment; the subsequent
 * `ac-fail --target igor` hit DUPLICATE_COMMENT_BLOCKED client-side, which
 * suppressed the ONLY mutation that triggers the proxy's atomic
 * applyStateTransition — the CLI exited 0 having applied nothing.
 *
 * AC1: rate-limited comment on a governed verb → hard error, nothing sent.
 *      Unchanged state:* labels after the trigger (proxy fail-open) → hard error.
 * AC2: duplicate-blocked comment → comment step is satisfied by the existing
 *      duplicate; a fallback intent-bearing issueUpdate still fires the transition.
 * AC3: delegate write that did not persist → hard error, not a stderr warning.
 */

import { getSelfUser } from "../auth";
import { getComments } from "../boards";
import { addComment, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { resolveLabelIds } from "../labels";
import { findSemanticState } from "../states";
import { acFail, submit, requestRevision } from "../semantic";
import { setProxyCommentSatisfiedBy } from "../client";

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

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockGetComments = getComments as jest.MockedFunction<typeof getComments>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockResolveLabelIds = resolveLabelIds as jest.MockedFunction<typeof resolveLabelIds>;
const mockSetSatisfiedBy = setProxyCommentSatisfiedBy as jest.MockedFunction<typeof setProxyCommentSatisfiedBy>;

const SELF = { id: "user-astrid", name: "Astrid (CPO)", email: "astrid@test.com" };

const AC_VALIDATE_LABELS = [
  { id: "label-wf-dev-impl", name: "wf:dev-impl" },
  { id: "label-ac-validate", name: "state:ac-validate" },
];

const IMPLEMENTATION_LABELS = [
  { id: "label-wf-dev-impl", name: "wf:dev-impl" },
  { id: "label-implementation", name: "state:implementation" },
];

const preIssue: any = {
  id: "issue-1",
  identifier: "AI-1767",
  title: "Repro ticket",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-doing", name: "Doing", type: "started" },
  assignee: null,
  delegate: { id: "user-astrid", name: "Astrid (CPO)" },
  labels: AC_VALIDATE_LABELS,
};

// Post-transition shape the proxy's atomic apply produces for ac-fail.
const appliedIssue: any = {
  ...preIssue,
  state: { id: "state-todo", name: "To Do", type: "unstarted" },
  delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
  labels: IMPLEMENTATION_LABELS,
};

const FEEDBACK = "AC not satisfied: search returns stale results on the live deployed build.";

function selfComment(body: string, ageSeconds: number): any {
  return {
    id: "comment-dup-1",
    body,
    createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    user: { id: SELF.id, name: SELF.name },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINEAR_PROXY_URL = "http://localhost:3100/proxy";
  process.env.LINEAR_POST_TRANSITION_VERIFY_DELAY_MS = "0"; // AI-2110: no real sleep in tests
  mockGetSelfUser.mockResolvedValue(SELF as any);
  mockGetComments.mockResolvedValue([]);
  mockGetIssue.mockResolvedValue(preIssue);
  mockUpdateIssue.mockResolvedValue(appliedIssue);
  mockResolveLabelIds.mockResolvedValue([]);
  mockFindSemanticState.mockResolvedValue({ id: "state-doing", name: "Doing", type: "started" } as any);
  mockResolveUserWithHints.mockResolvedValue({ id: "user-igor", name: "Igor (Back End Dev)" } as any);
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-new",
    commentUrl: "https://linear.app/c/new",
    commentCreatedAt: "2026-07-04T07:21:00Z",
    commentBodyLength: FEEDBACK.length,
    body: FEEDBACK,
  } as any);
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
});

describe("AC2 — duplicate-blocked comment must not abort the transition (AI-1767 replay)", () => {
  it("sends the fallback intent-bearing issueUpdate when the comment is dedup-satisfied", async () => {
    // The failure comment already exists (posted 17s ago by a prior blocked attempt).
    mockGetComments.mockResolvedValue([selfComment(FEEDBACK, 17)]);

    const result = await acFail("AI-1767", { comment: FEEDBACK, target: "Igor (Back End Dev)" });

    // No duplicate comment posted…
    expect(mockAddComment).not.toHaveBeenCalled();
    // …but the transition trigger STILL fires, with an empty payload: the proxy's
    // applyStateTransition is the sole writer of label + delegate + native state.
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-1767", {});
    // The satisfied-by header is set to the existing comment for requires_comment
    // gates, and cleared afterwards.
    expect(mockSetSatisfiedBy).toHaveBeenCalledWith("comment-dup-1");
    expect(mockSetSatisfiedBy).toHaveBeenLastCalledWith(undefined);

    expect(result.duplicateBlocked).toBe(true);
    expect(result.commentId).toBe("comment-dup-1");
    expect(result.delegate).toBe("Igor (Back End Dev)");
  });

  it("still hard-errors if the fallback trigger did not move the workflow label", async () => {
    mockGetComments.mockResolvedValue([selfComment(FEEDBACK, 17)]);
    // Proxy declined / fail-opened: ticket comes back unchanged.
    mockUpdateIssue.mockResolvedValue(preIssue);

    await expect(
      acFail("AI-1767", { comment: FEEDBACK, target: "Igor (Back End Dev)" })
    ).rejects.toThrow(/did NOT apply/);
  });
});

describe("AC1 — no silent half-applied transitions", () => {
  it("throws on a rate-limited comment instead of skipping the trigger with exit 0", async () => {
    mockGetComments.mockResolvedValue([
      selfComment("update one", 200),
      { ...selfComment("update two", 100), id: "c2" },
      { ...selfComment("update three", 30), id: "c3" },
    ]);

    await expect(acFail("AI-1767", { comment: FEEDBACK })).rejects.toThrow(/rate limit/i);
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("throws when the comment posted but the state:* label did not move (proxy fail-open)", async () => {
    // Comment is fresh (no duplicate), posts fine — but the post-trigger re-fetch
    // shows the ticket still in state:ac-validate.
    mockGetIssue.mockResolvedValueOnce(preIssue).mockResolvedValueOnce(preIssue);

    await expect(acFail("AI-1767", { comment: FEEDBACK })).rejects.toThrow(
      /did NOT apply.*state:ac-validate/s
    );
    expect(mockAddComment).toHaveBeenCalled();
  });

  it("succeeds when the proxy applied the transition (label moved, delegate routed)", async () => {
    mockGetIssue.mockResolvedValueOnce(preIssue).mockResolvedValueOnce(appliedIssue);

    const result = await acFail("AI-1767", { comment: FEEDBACK, target: "Igor (Back End Dev)" });
    expect(result.commentPosted).toBe(true);
    expect(result.delegate).toBe("Igor (Back End Dev)");
  });

  it("AI-2110: does NOT false-negative when the post-trigger read lags the applied transition", async () => {
    // Replica-lag replay of AI-1755: the proxy applied intake→routing atomically,
    // but the first post-trigger re-fetch lands on a stale replica that still shows
    // the pre-transition label set. The naive pre===post guard used to throw
    // "did NOT apply" here. The bounded re-poll must see the converged replica and
    // succeed — using the fresh read for the delegate check and result.
    mockGetIssue
      .mockResolvedValueOnce(preIssue) // line 458 pre-snapshot
      .mockResolvedValueOnce(preIssue) // line 789 post-read: stale (replica lag)
      .mockResolvedValueOnce(appliedIssue); // retry: replica converged

    const result = await acFail("AI-1767", { comment: FEEDBACK, target: "Igor (Back End Dev)" });
    expect(result.commentPosted).toBe(true);
    expect(result.delegate).toBe("Igor (Back End Dev)");
    // 3 reads: pre + stale post + one converged retry (not the full retry budget).
    expect(mockGetIssue).toHaveBeenCalledTimes(3);
  });

  it("AI-2110: still fails loudly on a genuine fail-open (never converges across retries)", async () => {
    // Every read — pre, post, and all retries — shows the unchanged label set.
    // This is a real proxy decline, not replica lag: it must still throw.
    mockGetIssue.mockResolvedValue(preIssue);

    await expect(
      acFail("AI-1767", { comment: FEEDBACK, target: "Igor (Back End Dev)" })
    ).rejects.toThrow(/did NOT apply/);
    // pre + post + full retry budget (3) = 5 reads before giving up.
    expect(mockGetIssue).toHaveBeenCalledTimes(5);
  });

  it("skips label verification off-proxy (direct API mode)", async () => {
    delete process.env.LINEAR_PROXY_URL;
    // Direct mode: updateIssue succeeded and already threw on any GraphQL error;
    // an unchanged label set must not fail the command.
    mockGetIssue.mockResolvedValueOnce(preIssue).mockResolvedValueOnce(appliedIssue);
    await expect(acFail("AI-1767", { comment: FEEDBACK })).resolves.toBeDefined();
  });
});

describe("AC3 — delegate write that does not persist is a hard error", () => {
  it("throws when the re-fetched delegate does not match the requested target", async () => {
    // Comment posts, but the proxy left the delegate on the validator.
    mockGetIssue
      .mockResolvedValueOnce(preIssue)
      .mockResolvedValueOnce({ ...appliedIssue, delegate: { id: "user-astrid", name: "Astrid (CPO)" } });

    await expect(
      acFail("AI-1767", { comment: FEEDBACK, target: "Igor (Back End Dev)" })
    ).rejects.toThrow(/delegate write did not persist/);
  });
});

describe("submit (requires_comment transition) shares the same recovery path", () => {
  it("dedup-satisfied submit fires the fallback trigger with the satisfied-by pointer", async () => {
    const reviewNote = "Implementation complete; PR #61 ready for code review with tests green.";
    mockGetComments.mockResolvedValue([{ ...selfComment(reviewNote, 25), id: "comment-submit-dup" }]);
    mockGetIssue.mockResolvedValue({ ...preIssue, labels: IMPLEMENTATION_LABELS });
    mockUpdateIssue.mockResolvedValue({
      ...preIssue,
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
      labels: [
        { id: "label-wf-dev-impl", name: "wf:dev-impl" },
        { id: "label-code-review", name: "state:code-review" },
      ],
    });

    const result = await submit("AI-1767", "Hanzo (Merge Gate)", { comment: reviewNote });
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-1767", {});
    expect(mockSetSatisfiedBy).toHaveBeenCalledWith("comment-submit-dup");
    expect(result.duplicateBlocked).toBe(true);
  });
});

/**
 * AI-1996: `request-revision` with a fresh (non-duplicate) --comment must post
 * the comment as the SOLE proxy trigger and emit NO post-transition
 * intent-bearing issueUpdate.
 *
 * Repro (astrid container, 2026-07-09, stale pre-`d49c3a7` 0.3.6 build): the CLI
 * sent the transition-triggering issueUpdate FIRST — which advanced the ticket
 * `ac-validate → implementation` — and then posted the comment carrying
 * intent=request-revision. The connector's `resolveMetaIntent` re-evaluated the
 * generic verb against the *post-transition* state (`implementation`), which has
 * no revision transition, so the commentCreate was rejected (`[Proxy]
 * 'request-revision' has no revision transition in state 'implementation'`), the
 * feedback was silently dropped, and the CLI exited 1 — leaving the re-dispatched
 * implementer with zero revision context.
 *
 * The comment-first machinery (`commentTriggersProxy`) makes the single
 * commentCreate both post the comment and trigger the atomic apply, so no second
 * intent-bearing mutation is ever sent. Guard: `updateIssue` must not be called
 * on the happy path — any post-transition intent mutation is exactly the
 * re-evaluation that produced the exit-1 drop.
 */
describe("AI-1996 — request-revision posts the comment as the sole trigger (no post-transition re-eval)", () => {
  it("posts the --comment and emits no intent-bearing issueUpdate after the transition applies", async () => {
    const revisionFeedback =
      "AC1 fails: search still returns stale results on the deployed build; see the ac-validate findings.";
    const revisedIssue = {
      ...preIssue,
      state: { id: "state-todo", name: "To Do", type: "unstarted" },
      delegate: { id: "user-sage", name: "Sage (Front End Dev)" },
      labels: IMPLEMENTATION_LABELS,
    };
    // getIssue #1 = pre-forward fetch (ac-validate); #2 = post-proxy re-fetch (implementation).
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValueOnce(preIssue);
    mockGetIssue.mockResolvedValueOnce(revisedIssue);
    mockAddComment.mockResolvedValue({
      issueId: "issue-1",
      commentId: "comment-revision",
      commentUrl: "https://linear.app/c/revision",
      commentCreatedAt: "2026-07-09T05:55:48Z",
      commentBodyLength: revisionFeedback.length,
      body: revisionFeedback,
    } as any);

    const result = await requestRevision("AI-1954", "sage", { comment: revisionFeedback });

    // The comment posted — the revision feedback is carried, not dropped.
    expect(mockAddComment).toHaveBeenCalledWith("AI-1954", revisionFeedback);
    expect(result.commentPosted).toBe(true);
    // The comment IS the trigger: no post-transition intent-bearing issueUpdate is
    // sent, so the connector never re-evaluates request-revision against the
    // already-advanced `implementation` state (the AI-1996 exit-1 drop).
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    // The label-verification backstop saw the state:* label move, so the transition
    // applied and the command did not throw.
    expect(result.state).toBe("To Do");
  });
});
