/**
 * INF-505 — handoff-work on a governed non-dev-impl ticket must route through the
 * proxy `handoff` intent (atomic delegate-only self-loop), not the generic raw
 * path that sends stateId + assignee + label deltas.
 *
 * Repro (2026-07-24, INF-497): a `task`-workflow ticket in state `doing`
 * (labels `wf:task` + `state:doing`, delegate = a reviewer) was handed off with
 * `linear handoff-work <ID> <agent>`. The CLI only routed dev-impl states through
 * the proxy intent; a `task` state fell through to the generic raw path, which
 * emits `{ stateId, delegateId, assigneeId, removedLabelIds }`. On a gated ticket
 * the connector's workflow-gate rejects that raw mutation ("Direct
 * status/assignee/delegate changes are blocked ... Use `submit`/`escape`") — but
 * only AFTER the comment posted first (`commentFirst`), stranding a partial
 * handoff (comment landed, delegate did not). It also left no legal edge to
 * return a `doing` ticket to its worker.
 *
 * Fix: route EVERY governed ticket (any `state:*` label) through the proxy
 * `handoff` intent. The connector allows the handoff meta-command from any
 * workflow state (workflow-gate INF-124/AI-1395) and writes the delegate
 * atomically as a self-loop, so:
 *   AC(a) — no blockable raw state/label mutation is emitted, so no comment is
 *           stranded behind a rejected write; a non-persisting delegate fails loud.
 *   AC(b) — a reviewer holding a `doing` ticket has a legal verb to route it back
 *           to the implementer (`handoff-work <ID> <worker>`).
 */

import { handoffWork } from "../semantic";
import { addComment, getIssue, updateIssue, resolveUserWithHints } from "../issues";
import { getSelfUser } from "../auth";
import { findSemanticState } from "../states";
import { setProxyIntent, setProxyTarget } from "../client";

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

const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;
const mockSetProxyTarget = setProxyTarget as jest.MockedFunction<typeof setProxyTarget>;

const TEAM = { id: "team-inf", key: "INF", name: "Infra" };
const REVIEWER = { id: "user-ai", name: "Ai", app: true };
const WORKER = { id: "user-igor", name: "Igor (Back End Dev)", app: true };
const TODO = { id: "s-todo", name: "To Do", type: "unstarted" };

/** A `task`-workflow ticket in `doing`, delegate = the reviewer (the stranded shape). */
const taskDoingIssue: any = {
  id: "issue-497",
  identifier: "INF-497",
  title: "Governed task in doing",
  team: TEAM,
  state: { id: "s-todo", name: "To Do", type: "unstarted" }, // task `doing` projects native To Do
  delegate: REVIEWER,
  assignee: null,
  labels: [{ name: "wf:task" }, { name: "state:doing" }],
};

/** Post-handoff shape the proxy's atomic self-loop apply produces: delegate = worker,
 *  state:* label unchanged (self-loop). */
const handedToWorker: any = {
  ...taskDoingIssue,
  delegate: WORKER,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINEAR_PROXY_URL = "http://localhost:3100/proxy";
  process.env.LINEAR_POST_TRANSITION_VERIFY_DELAY_MS = "0";
  mockGetSelfUser.mockResolvedValue(REVIEWER as any);
  mockResolveUserWithHints.mockResolvedValue(WORKER as any);
  mockFindSemanticState.mockResolvedValue(TODO as any);
  // Pre-fetch = stranded shape; post-trigger re-fetch = delegate now on the worker.
  mockGetIssue.mockResolvedValueOnce(taskDoingIssue).mockResolvedValue(handedToWorker);
  mockUpdateIssue.mockResolvedValue(handedToWorker);
  mockAddComment.mockResolvedValue({
    issueId: "issue-497",
    commentId: "comment-new",
    commentUrl: "https://linear.app/c/new",
    commentCreatedAt: "2026-07-24T19:30:00Z",
    commentBodyLength: 10,
    body: "x",
  } as any);
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
  delete process.env.LINEAR_POST_TRANSITION_VERIFY_DELAY_MS;
});

describe("INF-505 — governed non-dev-impl handoff routes through the proxy intent", () => {
  it("sets proxy intent 'handoff' on a task-workflow `doing` ticket (was intent-free before)", async () => {
    await handoffWork("INF-497", "Igor (Back End Dev)", { comment: "Deploy is yours — merge + AC5." });

    // Before the fix, a `task` state matched no dev-impl entry and took the raw
    // path with NO intent. Now every governed ticket routes through the intent.
    expect(mockSetProxyIntent).toHaveBeenNthCalledWith(1, "handoff");
    expect(mockSetProxyIntent).toHaveBeenLastCalledWith(undefined);
  });

  it("forwards the explicit worker target for multi-body task roles", async () => {
    await handoffWork("INF-497", "Igor (Back End Dev)", { comment: "Deploy is yours — merge + AC5." });

    // `task.yaml` resolves `worker` through a multi-body role. Without
    // X-Openclaw-Target as the roster body key, the connector falls back to role
    // resolution and fail-closes with "multi-body role 'worker' requires a --target".
    expect(mockSetProxyTarget).toHaveBeenNthCalledWith(1, "igor");
    expect(mockSetProxyTarget).toHaveBeenLastCalledWith(undefined);
  });

  it("AC(a): emits no blockable raw state/label/delegate mutation, then comments after the delegate lands", async () => {
    await handoffWork("INF-497", "Igor (Back End Dev)", { comment: "Deploy is yours — merge + AC5." });

    // The empty update carries the intent and explicit target. Critically, the CLI
    // never sends the { stateId, assigneeId, removedLabelIds, delegateId } raw
    // mutation the gate rejects; that rejection after commentFirst was the partial
    // handoff bug. The comment is posted only after the proxy write returns.
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith("INF-497", {});
    expect(mockAddComment).toHaveBeenCalledWith("INF-497", "Deploy is yours — merge + AC5.");
    expect(mockUpdateIssue.mock.invocationCallOrder[0]).toBeLessThan(mockAddComment.mock.invocationCallOrder[0]);
    for (const call of mockUpdateIssue.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("stateId");
      expect(payload).not.toHaveProperty("addedLabelIds");
      expect(payload).not.toHaveProperty("removedLabelIds");
      expect(payload).not.toHaveProperty("delegateId");
      expect(payload).not.toHaveProperty("assigneeId");
    }
  });

  it("AC(a): a commentless governed handoff triggers with an empty intent-bearing payload only", async () => {
    // No comment ⇒ the empty {} issueUpdate carries the intent; still no raw
    // state/label/delegate fields for the gate to reject.
    await handoffWork("INF-497", "Igor (Back End Dev)");

    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).toHaveBeenCalledWith("INF-497", {});
  });

  it("AC(b): a reviewer routes a `doing` ticket back to the worker — delegate lands on the worker", async () => {
    const result = await handoffWork("INF-497", "Igor (Back End Dev)", {
      comment: "Deploy is yours — merge + AC5.",
    });

    // The self-loop preserves the workflow state (still `doing`) and re-delegates
    // to the implementer: the legal worker-return edge INF-505 defect #2 wanted.
    expect(result.delegate).toBe("Igor (Back End Dev)");
    expect(result.commentPosted).toBe(true);
  });

  it("AC(a): fails loudly (no silent partial) when the proxy did not persist the delegate", async () => {
    // Proxy declined / fail-opened: the post-trigger re-fetch still shows the reviewer.
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValue(taskDoingIssue); // pre AND every post read: delegate unchanged
    mockUpdateIssue.mockResolvedValue(taskDoingIssue);

    await expect(
      handoffWork("INF-497", "Igor (Back End Dev)", { comment: "Deploy is yours." })
    ).rejects.toThrow(/delegate write did not persist/);
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});

describe("INF-505 — ungoverned (ad-hoc) handoffs keep the intent-free path", () => {
  it("sets no proxy intent when the ticket carries no state:* label", async () => {
    const adHoc: any = {
      ...taskDoingIssue,
      labels: [], // no wf:*/state:* — a plain delegated ticket
      delegate: REVIEWER,
    };
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValueOnce(adHoc).mockResolvedValue({ ...adHoc, delegate: WORKER });
    mockUpdateIssue.mockResolvedValue({ ...adHoc, delegate: WORKER });

    await handoffWork("INF-000", "Igor (Back End Dev)", { comment: "yours" });

    // Ad-hoc tickets are not gated, so the plain delegate change still goes direct.
    expect(mockSetProxyIntent).not.toHaveBeenCalled();
  });
});
