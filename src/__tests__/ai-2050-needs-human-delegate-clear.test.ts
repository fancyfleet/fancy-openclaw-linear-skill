/**
 * AI-2050 — `needs-human` leaves the delegate set, looping blocked tickets back
 * into agent queues.
 *
 * Root cause chain (verified against connector @ 7fda8e7):
 *   1. `needsHuman` asks for `delegateId: null` (state-machine `clearDelegate`).
 *   2. The CLI sets the `needs-human` proxy intent, so the connector's
 *      `stripNullDelegateAssigneeFields` (proxy.ts, AI-1857) deletes that null
 *      before forwarding to Linear.
 *   3. `applyStateTransition` no-ops on ad-hoc tickets (`!workflowId → noop`),
 *      so nothing else clears it.
 *   4. `linear queue` serves by *delegate* → the escalating agent is handed the
 *      blocked ticket again on every heartbeat (AI-2048: four near-identical
 *      "still blocked" comments in 90 minutes).
 *
 * The tests below model the proxy's strip: the combined intent-bearing mutation
 * ignores `delegateId: null`, while a plain `{delegateId: null}` mutation (the
 * shape `undelegate` uses, and the one the corrective write issues) is honored.
 */
import { handoffWork, needsHuman } from "../semantic";
import { getSelfUser } from "../auth";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import { formatRefusalError, ESCALATION_PATTERN_LOG_RELPATH } from "../matt-escalation-guard";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
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

jest.mock("../labels", () => ({ resolveLabelIds: jest.fn().mockResolvedValue([]) }));

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockFindUserByName = findUserByName as jest.MockedFunction<typeof findUserByName>;

const AI = { id: "user-ai", name: "Ai (Chief of Staff)", app: true };
const MATT = { id: "user-matt", name: "Matt Henry", app: false };
const HANZO = { id: "user-hanzo", name: "Hanzo (Merge Gate)", app: true };

const todoState = { id: "state-todo", name: "Todo", type: "unstarted" };

/** A ticket escalated to a human while an agent is still its delegate. */
const delegatedIssue: any = {
  id: "issue-1",
  identifier: "AI-2048",
  title: "Blocked on a human",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: todoState,
  assignee: null,
  delegate: { id: AI.id, name: AI.name },
  labels: [],
};

/**
 * Stand in for the connector proxy. The intent-bearing transition mutation carries
 * `stateId`; its `delegateId: null` is stripped (AI-1857). A bare `{delegateId: null}`
 * is an intent-free mutation and is forwarded to Linear untouched.
 */
function installProxyStripBehavior(opts: { refuseRawClear?: boolean } = {}) {
  const byId: Record<string, any> = { [HANZO.id]: HANZO, [MATT.id]: MATT, [AI.id]: AI };
  let current: any = { ...delegatedIssue };
  mockGetIssue.mockImplementation(async () => ({ ...current }));
  mockUpdateIssue.mockImplementation(async (_id: string, input: any) => {
    const isIntentBearing = "stateId" in input;
    if ("assigneeId" in input) {
      current.assignee = input.assigneeId === null ? null : byId[input.assigneeId] ?? current.assignee;
    }
    if ("delegateId" in input) {
      if (input.delegateId !== null) {
        // A non-null delegate write is never stripped.
        current.delegate = byId[input.delegateId] ?? { id: input.delegateId, name: input.delegateId };
      } else if (isIntentBearing) {
        // AI-1857: the proxy deletes delegateId:null from intent-bearing mutations.
      } else {
        if (opts.refuseRawClear) {
          throw new Error(
            "[Proxy] Direct delegate clear blocked: the current delegate may re-route AI-2048 " +
              "but may not null the delegate field directly. Use undelegate or handoff-work to release ownership."
          );
        }
        current.delegate = null;
      }
    }
    return { ...current };
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetSelfUser.mockResolvedValue({ id: AI.id, name: AI.name, email: "ai@test.com" });
  mockFindSemanticState.mockResolvedValue(todoState as any);
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-uuid",
    commentUrl: "https://linear.app/test/comment/comment-uuid",
    commentCreatedAt: "2026-07-10T10:00:00Z",
    commentBodyLength: 10,
    body: "blocked",
  } as any);
  const users: Record<string, any> = {
    [MATT.name]: MATT,
    [HANZO.name]: HANZO,
    [AI.name]: AI,
  };
  mockResolveUserWithHints.mockImplementation(async (name: string) => {
    const u = users[name];
    if (!u) throw new Error(`Could not uniquely resolve Linear user "${name}".`);
    return u;
  });
  mockFindUserByName.mockImplementation(async (name: string) => users[name]);
});

describe("AI-2050 AC1 — needs-human clears the delegate", () => {
  it("re-issues the delegate clear as an intent-free mutation when the proxy strips it", async () => {
    installProxyStripBehavior();

    const result = await needsHuman("AI-2048", "Matt Henry", { comment: "Blocked on a credential." });

    // The escalation landed...
    expect(result.assignee).toBe("Matt Henry");
    // ...and the delegate is actually gone, not merely requested to be gone.
    expect(result.delegate).toBeNull();

    // Second mutation is the corrective clear: bare delegateId:null, no stateId,
    // no assigneeId — the shape the proxy forwards untouched.
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
    expect(mockUpdateIssue.mock.calls[1][1]).toEqual({ delegateId: null });
  });

  it("does not issue a corrective write when the delegate is already clear", async () => {
    let current: any = { ...delegatedIssue, delegate: null };
    mockGetIssue.mockImplementation(async () => ({ ...current }));
    mockUpdateIssue.mockImplementation(async (_id: string, input: any) => {
      if (input.assigneeId) current.assignee = { id: MATT.id, name: MATT.name };
      return { ...current };
    });

    const result = await needsHuman("AI-2048", "Matt Henry", { comment: "Blocked." });

    expect(result.delegate).toBeNull();
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
  });

  it("warns with the still-set delegate and the undelegate remedy when the proxy refuses the raw clear", async () => {
    installProxyStripBehavior({ refuseRawClear: true });
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await needsHuman("AI-2048", "Matt Henry", { comment: "Blocked." });

    const warning = spy.mock.calls.map((c) => String(c[0])).join("");
    spy.mockRestore();

    // AC1 second branch: name the delegate, and name the remedy.
    expect(warning).toContain(AI.name);
    expect(warning).toContain("linear undelegate AI-2048");
    expect(warning).toMatch(/still its delegate/i);
    // ...and say why the clear failed, rather than swallowing the proxy's answer.
    expect(warning).toContain("Direct delegate clear blocked");

    // The escalation is NOT rolled back — assignee + comment already landed.
    expect(result.assignee).toBe("Matt Henry");
    expect(mockAddComment).toHaveBeenCalled();
    // ...but the result reports the truth: the delegate survived.
    expect(result.delegate).toBe(AI.name);
  });
});

describe("AI-2050 AC2 — handoff-work to a human fails with an actionable error", () => {
  beforeEach(() => installProxyStripBehavior());

  it("names needs-human as the remedy instead of surfacing the raw GraphQL error", async () => {
    await expect(handoffWork("AI-2048", "Matt Henry", { comment: "Over to you." })).rejects.toThrow(
      /linear needs-human AI-2048 "Matt Henry"/
    );
  });

  it("does not surface the raw 'delegateId must correspond to an app user' text", async () => {
    await expect(handoffWork("AI-2048", "Matt Henry", {})).rejects.not.toThrow(/must correspond to an app user/i);
  });

  it("fails before posting the comment or mutating the issue", async () => {
    await expect(handoffWork("AI-2048", "Matt Henry", { comment: "Over to you." })).rejects.toThrow();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("still hands off normally to an app user (agent)", async () => {
    const result = await handoffWork("AI-2048", "Hanzo (Merge Gate)", { comment: "Merge it." });
    expect(result.command).toBe("handoffWork");
    expect(mockUpdateIssue).toHaveBeenCalled();
  });

  it("rejects a delegate whose app flag is null, not just false", async () => {
    mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-matt", name: "Matt Henry", app: null });
    await expect(handoffWork("AI-2048", "Matt Henry", {})).rejects.toThrow(/must be app users/i);
  });

  it("allows a raw UUID delegate, where appness is unknowable", async () => {
    const uuid = "3ac1e065-df43-40df-b535-217f21266343";
    mockResolveUserWithHints.mockResolvedValueOnce({ id: uuid, name: uuid });
    await expect(handoffWork("AI-2048", uuid, {})).resolves.toBeDefined();
  });
});

describe("AI-2050 AC3 — refusal message and pattern log point at live vault paths", () => {
  it("cites the canonical governance/escalation-rules.md path", () => {
    const msg = formatRefusalError("AI-2048", { category: "gh-auth", matchedText: "gh auth" });
    expect(msg).toContain("~/obsidian-vault/governance/escalation-rules.md");
  });

  it("no longer cites the dead post-restructure path", () => {
    const msg = formatRefusalError("AI-2048", { category: "gh-auth", matchedText: "gh auth" });
    expect(msg).not.toContain("ai-systems/areas/agent-behavior");
  });

  it("writes the pattern log to its post-restructure location", () => {
    expect(ESCALATION_PATTERN_LOG_RELPATH).toBe("obsidian-vault/life-os/infra/agents/escalation-pattern-log.md");
  });
});
