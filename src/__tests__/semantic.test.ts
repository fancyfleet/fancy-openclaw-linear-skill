import fs from "node:fs/promises";

import { getSelfUser } from "../auth";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import {
  considerWork,
  observeIssue,
  refuseWork,
  beginWork,
  handoffWork,
  complete,
  needsHuman,
  note,
  undelegate,
  historyToTimelineEvents,
} from "../semantic";
import { IssueHistory } from "../types";

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

import { getComments } from "../boards";
const mockGetComments = getComments as jest.MockedFunction<typeof getComments>;

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn(),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn(),
}));
import { resolveLabelIds } from "../labels";
const mockResolveLabelIds = resolveLabelIds as jest.MockedFunction<typeof resolveLabelIds>;

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockFindUserByName = findUserByName as jest.MockedFunction<typeof findUserByName>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;

const baseIssue: any = {
  id: "issue-1",
  identifier: "AI-100",
  title: "Test Issue",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-todo", name: "Todo", type: "unstarted" },
  assignee: { id: "user-matt", name: "Matt Henry" },
  delegate: null,
};

const thinkingState = { id: "state-thinking", name: "In Progress", type: "started" };
const doingState = { id: "state-doing", name: "In Progress", type: "started" };
const todoState = { id: "state-todo", name: "Todo", type: "unstarted" };
const doneState = { id: "state-done", name: "Done", type: "completed" };

beforeEach(() => {
  jest.resetAllMocks();
  mockGetComments.mockResolvedValue([]);
  mockGetIssue.mockResolvedValue(baseIssue);
  mockGetSelfUser.mockResolvedValue({ id: "user-igor", name: "Igor (Back End Dev)", email: "igor@test.com" });
  mockFindUserByName.mockImplementation(async (name: string) => {
    const users: Record<string, { id: string; name: string }> = {
      "Charles (CTO)": { id: "user-charles", name: "Charles (CTO)" },
      "Matt Henry": { id: "user-matt", name: "Matt Henry" },
      "Igor (Back End Dev)": { id: "user-igor", name: "Igor (Back End Dev)" },
    };
    const user = users[name];
    if (!user) throw new Error(`Could not uniquely resolve Linear user "${name}".`);
    return user;
  });
  mockResolveUserWithHints.mockImplementation(async (name: string) => {
    const users: Record<string, { id: string; name: string; email?: string | null }> = {
      "Charles (CTO)": { id: "user-charles", name: "Charles (CTO)" },
      "Matt Henry": { id: "user-matt", name: "Matt Henry" },
      "Igor (Back End Dev)": { id: "user-igor", name: "Igor (Back End Dev)" },
    };
    const user = users[name];
    if (!user) throw new Error(`Could not uniquely resolve Linear user "${name}".`);
    return user;
  });
  mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
    const map: Record<string, any> = {
      thinking: thinkingState,
      doing: doingState,
      todo: todoState,
      done: doneState,
    };
    return map[semantic] ?? todoState;
  });
  mockAddComment.mockResolvedValue({ issueId: "issue-1", commentId: "comment-uuid", commentUrl: "https://linear.app/test/comment/comment-uuid", commentCreatedAt: "2026-04-26T12:00:00Z", commentBodyLength: 4, body: "test" });
  // Simulate the real updateIssue behaviour: translate stateId/delegateId/assigneeId
  // back into the Issue shape that executeTransition reads from updatedIssue.
  const _updateUserMap: Record<string, { id: string; name: string }> = {
    "user-charles": { id: "user-charles", name: "Charles (CTO)" },
    "user-matt": { id: "user-matt", name: "Matt Henry" },
    "user-igor": { id: "user-igor", name: "Igor (Back End Dev)" },
  };
  const _updateStateMap: Record<string, any> = {
    "state-thinking": thinkingState,
    "state-doing": doingState,
    "state-todo": todoState,
    "state-done": doneState,
  };
  mockUpdateIssue.mockImplementation(async (_id: string, input: any) => {
    const currentIssue = await mockGetIssue(_id);
    const result: any = { ...currentIssue };
    if (input.stateId !== undefined) {
      result.state = _updateStateMap[input.stateId] ?? currentIssue.state;
    }
    if ("delegateId" in input) {
      result.delegate = input.delegateId === null ? null : _updateUserMap[input.delegateId] ?? null;
    }
    if ("assigneeId" in input) {
      result.assignee = input.assigneeId === null ? null : _updateUserMap[input.assigneeId] ?? currentIssue.assignee;
    }
    return result;
  });
  mockResolveLabelIds.mockImplementation(async (_teamId: string, names: string[]) => {
    const map: Record<string, string> = {
      "gate:agent-review": "lbl-agent-review",
      "gate:human-review": "lbl-human-review",
      "state:intake": "lbl-state-intake",
      "state:implementation": "lbl-state-impl",
      "state:code-review": "lbl-state-code-review",
      "state:deployment": "lbl-state-deployment",
      "state:done": "lbl-state-done",
      "wf:dev-impl": "lbl-wf-dev-impl",
    };
    const ids: string[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const id = map[n.toLowerCase()];
      if (id) ids.push(id);
      else missing.push(n);
    }
    if (missing.length) throw new Error(`Label(s) not found: ${missing.join(", ")}`);
    return ids;
  });
});

describe("observeIssue", () => {
  it("preserves comment author app/isAgent metadata for presentation rendering", async () => {
    mockGetComments.mockResolvedValue([
      {
        id: "c-human",
        body: "Human note",
        createdAt: "2026-01-01T00:00:00Z",
        user: { id: "user-matt", name: "Matt Henry", app: false, isAgent: false },
      },
      {
        id: "c-agent",
        body: "Agent note",
        createdAt: "2026-01-02T00:00:00Z",
        user: { id: "user-igor", name: "Igor (Back End Dev)", app: true },
      },
    ]);

    const result = await observeIssue("AI-100");

    expect(result.comments[0].user).toMatchObject({
      name: "Matt Henry",
      app: false,
      isAgent: false,
    });
    expect(result.comments[1].user).toMatchObject({
      name: "Igor (Back End Dev)",
      app: true,
    });
  });
});

describe("considerWork", () => {
  it("sets delegate=self, status=In Progress, assignee=null", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
    });
    const result = await considerWork("AI-100");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-thinking",
      delegateId: "user-igor",
      assigneeId: null,
    });
    expect(result).toMatchObject({
      command: "considerWork",
      issueId: "AI-100",
      state: "In Progress",
      delegate: "Igor (Back End Dev)",
      assignee: null,
      commentPosted: false,
    });
    expect(result.context).toBeDefined();
    expect(result.context?.identifier).toBe("AI-100");
  });

  it("does not post any comment", async () => {
    await considerWork("AI-100");
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("preserves comment author app/isAgent metadata in returned context", async () => {
    mockGetComments.mockResolvedValue([
      {
        id: "c-human",
        body: "Human note",
        createdAt: "2026-01-01T00:00:00Z",
        user: { id: "user-matt", name: "Matt Henry", app: false, isAgent: false },
      },
    ]);

    const result = await considerWork("AI-100");

    expect(result.context?.comments[0].user).toMatchObject({
      name: "Matt Henry",
      app: false,
      isAgent: false,
    });
  });

  it("no-ops when the issue is no longer delegated or assigned to self", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      delegate: { id: "user-charles", name: "Charles (CTO)" },
      assignee: null,
    });

    const result = await considerWork("AI-100");

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      command: "considerWork",
      issueId: "AI-100",
      state: "Todo",
      delegate: "Charles (CTO)",
      assignee: null,
      commentPosted: false,
    });
    expect(result.context).toBeDefined();
  });

  it("throws when issue has no team", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, team: null });
    await expect(considerWork("AI-100")).rejects.toThrow("no team");
  });

  it("is idempotent — no state update when already In Progress", async () => {
    // A ticket that's already had consider-work run has: delegate=self, assignee=null, state=thinking.
    // The skipIfSameState + ownershipSatisfied guard should no-op without calling updateIssue.
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
      assignee: null,
      state: { id: "state-thinking", name: "In Progress", type: "started" },
    });
    const result = await considerWork("AI-100");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.state).toBe("In Progress");
  });

  it("no-ops on Done tickets so stale delegation hooks do not reopen completed work", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      identifier: "AI-501",
      state: { id: "state-done", name: "Done", type: "completed" },
      delegate: null,
      assignee: null,
    });

    const result = await considerWork("AI-501");

    expect(mockFindSemanticState).not.toHaveBeenCalled();
    expect(mockGetSelfUser).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      command: "considerWork",
      issueId: "AI-501",
      state: "Done",
      delegate: null,
      assignee: null,
      commentPosted: false,
    });
    expect(result.context?.state.name).toBe("Done");
  });

  it("no-ops on Canceled tickets", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-canceled", name: "Canceled", type: "canceled" },
    });

    const result = await considerWork("AI-100");

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result.state).toBe("Canceled");
  });

  it("can force considerWork on a terminal ticket", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-done", name: "Done", type: "completed" },
    });

    const result = await considerWork("AI-100", { force: true });

    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-thinking",
      delegateId: "user-igor",
      assigneeId: null,
    });
    expect(result.state).toBe("In Progress");
  });

  it("hard-rejects Backlog tickets unless forced", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-backlog", name: "Backlog", type: "backlog" },
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
    });

    await expect(considerWork("AI-100")).rejects.toThrow("Ticket is in Backlog — cannot consider work. Use `linear observe-issue` to view, or wait for promotion to To Do.");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("can force considerWork on a Backlog ticket with a visible warning", async () => {
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-backlog", name: "Backlog", type: "backlog" },
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
    });

    const result = await considerWork("AI-100", { force: true });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("forced past Backlog gate"));
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-thinking",
      delegateId: "user-igor",
      assigneeId: null,
    });
    expect(result.state).toBe("In Progress");
    stderrSpy.mockRestore();
  });

  // AI-1394 regression: concurrent-grab via delegate+assignee overlap
  it("no-ops when self is assignee but NOT delegate (requireSelfDelegated guard)", async () => {
    // Igor is assignee but Charles is delegate — Igor should not claim the ticket.
    // Previously requireSelfAssignedOrDelegated allowed this, enabling concurrent-grab.
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      delegate: { id: "user-charles", name: "Charles (CTO)" },
      assignee: { id: "user-igor", name: "Igor (Back End Dev)" },
    });

    const result = await considerWork("AI-100");

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.state).toBe("Todo");
    expect(result.context).toBeDefined();
  });

  // AI-1394 regression: stale consider-work wake reverting an advanced state
  it("no-ops when current state position is past the thinking state (advancement guard)", async () => {
    // Simulates the race: Charles ran `linear approve` (Doing, position=3) then Igor's
    // stale consider-work wake fires. The position guard must prevent reverting to Thinking.
    const doingStateWithPosition = { id: "state-doing", name: "Doing", type: "started", position: 3 };
    const thinkingStateWithPosition = { id: "state-thinking", name: "Thinking", type: "started", position: 1 };
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: doingStateWithPosition,
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
      assignee: null,
    });
    mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
      if (semantic === "thinking") return thinkingStateWithPosition;
      return doingStateWithPosition;
    });

    const result = await considerWork("AI-100");

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
    // Returns the current (advanced) state name, not "Thinking"
    expect(result.state).toBe("Doing");
    expect(result.context).toBeDefined();
  });

  it("proceeds when current state position is before the target (todo→thinking is not 'ahead')", async () => {
    const thinkingStateWithPosition = { id: "state-thinking", name: "Thinking", type: "started", position: 1 };
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-todo", name: "Todo", type: "unstarted", position: 0 },
      delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
      assignee: null,
    });
    mockFindSemanticState.mockImplementation(async () => thinkingStateWithPosition);

    const result = await considerWork("AI-100");

    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.state).toBe("Thinking");
  });

  it("force bypasses both advancement guard and delegate-only ownership", async () => {
    const doingStateWithPosition = { id: "state-doing", name: "Doing", type: "started", position: 3 };
    const thinkingStateWithPosition = { id: "state-thinking", name: "Thinking", type: "started", position: 1 };
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: doingStateWithPosition,
      // Not the delegate — but force should bypass ownership check too
      delegate: { id: "user-charles", name: "Charles (CTO)" },
      assignee: null,
    });
    mockFindSemanticState.mockImplementation(async () => thinkingStateWithPosition);

    const result = await considerWork("AI-100", { force: true });

    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-thinking",
      delegateId: "user-igor",
      assigneeId: null,
    });
    expect(result.state).toBe("Thinking");
  });
});

describe("refuseWork", () => {
  it("sets status=Todo, delegate=specified user, posts comment", async () => {
    const result = await refuseWork("AI-100", "Charles (CTO)", { comment: "Not my area." });
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "Not my area.");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-todo",
      delegateId: "user-charles",
    });
    expect(result.delegate).toBe("Charles (CTO)");
    expect(result.state).toBe("Todo");
    expect(result.commentPosted).toBe(true);
  });

  it("reads comment from file", async () => {
    jest.spyOn(fs, "readFile").mockResolvedValueOnce("File refusal reason");
    const result = await refuseWork("AI-100", "Charles (CTO)", { commentFile: "/path/to/file.md" });
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "File refusal reason");
    expect(result.commentPosted).toBe(true);
  });

  it("succeeds without comment (emits stderr warning)", async () => {
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await refuseWork("AI-100", "Charles (CTO)", {});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("no comment provided"));
    spy.mockRestore();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-todo",
      delegateId: "user-charles",
    });
    expect(result.commentPosted).toBe(false);
  });

  it("treats whitespace-only comment as empty (emits stderr warning)", async () => {
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await refuseWork("AI-100", "Charles (CTO)", { comment: "   " });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("no comment provided"));
    spy.mockRestore();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(false);
  });
});

describe("beginWork", () => {
  it("sets status to In Progress when not already there", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, state: { name: "Todo", type: "unstarted" } });
    const result = await beginWork("AI-100");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", { stateId: "state-doing" });
    expect(result.state).toBe("In Progress");
  });

  it("is idempotent — no state update when already In Progress", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-doing", name: "In Progress", type: "started" },
    });
    const result = await beginWork("AI-100");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result.state).toBe("In Progress");
  });

  it("does not post any comment", async () => {
    await beginWork("AI-100");
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("preserves existing delegate and assignee", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { name: "Todo", type: "unstarted" },
      delegate: { id: "user-igor", name: "Igor" },
      assignee: null,
    });
    const result = await beginWork("AI-100");
    expect(result.delegate).toBe("Igor");
    expect(result.assignee).toBeNull();
  });
});

describe("handoffWork", () => {
  it("sets status=Todo, delegate=agent, clears assignee, posts comment", async () => {
    const result = await handoffWork("AI-100", "Charles (CTO)", { comment: "Your turn." });
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "Your turn.");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-todo",
      delegateId: "user-charles",
      assigneeId: null,
    });
    expect(result).toEqual({
      command: "handoffWork",
      issueId: "AI-100",
      state: "Todo",
      delegate: "Charles (CTO)",
      assignee: null,
      commentPosted: true,
      duplicateBlocked: false,
      duplicateDetails: null,
      rateLimitBlocked: false,
      rateLimitDetails: null,
      commentId: "comment-uuid",
      commentUrl: "https://linear.app/test/comment/comment-uuid",
      commentCreatedAt: "2026-04-26T12:00:00Z",
      commentBodyLength: 4,
      bodyFile: null,
    });
  });

  it("succeeds without comment (emits stderr warning)", async () => {
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await handoffWork("AI-100", "Charles (CTO)", {});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("no comment provided"));
    spy.mockRestore();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-todo",
      delegateId: "user-charles",
      assigneeId: null,
    });
    expect(result.commentPosted).toBe(false);
  });

  it("is idempotent — safe to call multiple times", async () => {
    // First call
    await handoffWork("AI-100", "Charles (CTO)", { comment: "Handing off." });
    // Second call with same params — should succeed without error
    await handoffWork("AI-100", "Charles (CTO)", { comment: "Re-confirming handoff." });
    expect(mockAddComment).toHaveBeenCalledTimes(2);
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
  });

  describe("--review-handoff", () => {
    it("applies gate:agent-review label and prepends [Review Handoff] to inline comment", async () => {
      await handoffWork("AI-100", "Charles (CTO)", {
        reviewHandoff: true,
        comment: "Audit complete, ready for review.",
      });
      expect(mockAddComment).toHaveBeenCalledWith("AI-100", "[Review Handoff]\n\nAudit complete, ready for review.");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-todo",
        delegateId: "user-charles",
        assigneeId: null,
        addedLabelIds: ["lbl-agent-review"],
      });
    });

    it("preserves comment when it already starts with [Review Handoff]", async () => {
      await handoffWork("AI-100", "Charles (CTO)", {
        reviewHandoff: true,
        comment: "[Review Handoff] Already prefixed.",
      });
      expect(mockAddComment).toHaveBeenCalledWith("AI-100", "[Review Handoff] Already prefixed.");
    });

    it("prepends prefix to comment-file body when missing", async () => {
      jest.spyOn(fs, "readFile").mockResolvedValueOnce("Audit body from file");
      await handoffWork("AI-100", "Charles (CTO)", {
        reviewHandoff: true,
        commentFile: "/tmp/comment.md",
      });
      expect(mockAddComment).toHaveBeenCalledWith("AI-100", "[Review Handoff]\n\nAudit body from file");
    });

    it("succeeds without a comment, still applies label and warns", async () => {
      const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
      await handoffWork("AI-100", "Charles (CTO)", { reviewHandoff: true });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("no comment provided"));
      spy.mockRestore();
      expect(mockAddComment).not.toHaveBeenCalled();
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-todo",
        delegateId: "user-charles",
        assigneeId: null,
        addedLabelIds: ["lbl-agent-review"],
      });
    });

    it("throws helpful error before any mutation when label is missing on team", async () => {
      mockResolveLabelIds.mockImplementation(async (_teamId: string, names: string[]) => {
        throw new Error(`Label(s) not found: ${names.join(", ")}`);
      });
      await expect(
        handoffWork("AI-100", "Charles (CTO)", { reviewHandoff: true, comment: "..." })
      ).rejects.toThrow(/--review-handoff requires the "gate:agent-review" label/);
      expect(mockUpdateIssue).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });

    it("does not apply label when --review-handoff is absent", async () => {
      await handoffWork("AI-100", "Charles (CTO)", { comment: "Plain handoff." });
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-todo",
        delegateId: "user-charles",
        assigneeId: null,
      });
    });

    it("omits assigneeId (does NOT pass null) when delegating to an app user — avoids silent delegate drop (AI-1395)", async () => {
    mockResolveUserWithHints.mockImplementation(async (name: string) => {
      if (name === "Igor (Back End Dev)") return { id: "user-igor", name: "Igor (Back End Dev)", app: true };
      return { id: "user-charles", name: "Charles (CTO)" };
    });
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    await handoffWork("AI-100", "Igor (Back End Dev)", { comment: "Your turn." });
    spy.mockRestore();
    const call = mockUpdateIssue.mock.calls[0][1] as any;
    // delegateId must be present
    expect(call.delegateId).toBe("user-igor");
    // assigneeId must be ABSENT (undefined), not null — passing null silently drops app-user delegates
    expect(call.assigneeId).toBeUndefined();
  });

  it("preserves the state:* projection label and native column on a dev-impl handoff — owner change is not a state change (AI-1494)", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "lbl-impl", name: "state:implementation", color: "#0f0" }],
      });
      await handoffWork("AI-100", "Charles (CTO)", { comment: "Handing back." });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      // Only the delegate changes. The native column (stateId) is left to the proxy
      // (omitted here), the active state:* label is NOT stripped, and assignee is not
      // cleared — sending stateId/assigneeId/labelIds would trip the proxy's
      // raw-mutation interception and drop the projection.
      expect(call.delegateId).toBe("user-charles");
      expect(call.stateId).toBeUndefined();
      expect(call.removedLabelIds).toBeUndefined();
      expect(call.addedLabelIds).toBeUndefined();
      expect(call.assigneeId).toBeUndefined();
    });

  it("does not strip or resolve any state:* label on a dev-impl handoff (AI-1494 supersedes the AI-1404 strip path)", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      labels: [{ id: "lbl-intake", name: "state:intake", color: "#00f" }],
    });
    await handoffWork("AI-100", "Charles (CTO)", { comment: "Only intake label present." });
    const call = mockUpdateIssue.mock.calls[0][1] as any;
    // The intake projection is preserved — no removal, no label resolution at all.
    expect(call.removedLabelIds).toBeUndefined();
    expect(call.stateId).toBeUndefined();
    expect(mockResolveLabelIds).not.toHaveBeenCalled();
  });
  });
});

describe("complete", () => {
  it("sets status=Done, clears delegate and assignee", async () => {
    const result = await complete("AI-100", { comment: "All done!" });
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "All done!");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-done",
      delegateId: null,
      assigneeId: null,
    });
    expect(result.state).toBe("Done");
    expect(result.delegate).toBeNull();
    expect(result.assignee).toBeNull();
  });

  it("works without a comment", async () => {
    const result = await complete("AI-100");
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(false);
  });

  describe("auto-unlabel of review gates", () => {
    it("strips gate:agent-review when present on close", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "lbl-agent-review", name: "gate:agent-review" }],
      });
      await complete("AI-100");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-done",
        delegateId: null,
        assigneeId: null,
        removedLabelIds: ["lbl-agent-review"],
      });
    });

    it("strips gate:human-review when present on close", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "lbl-human-review", name: "gate:human-review" }],
      });
      await complete("AI-100");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-done",
        delegateId: null,
        assigneeId: null,
        removedLabelIds: ["lbl-human-review"],
      });
    });

    it("strips both review labels when both present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "lbl-agent-review", name: "gate:agent-review" },
          { id: "lbl-human-review", name: "gate:human-review" },
          { id: "lbl-bug", name: "bug" },
        ],
      });
      await complete("AI-100");
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.stateId).toBe("state-done");
      expect(call.removedLabelIds).toEqual(expect.arrayContaining(["lbl-agent-review", "lbl-human-review"]));
      expect(call.removedLabelIds).toHaveLength(2);
    });

    it("does not touch labels when no review gates are present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "lbl-bug", name: "bug" }],
      });
      await complete("AI-100");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-done",
        delegateId: null,
        assigneeId: null,
      });
    });

    it("omits removedLabelIds when issue has no review gate labels (AI-1389 new behavior)", async () => {
      await complete("AI-100");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
        stateId: "state-done",
        delegateId: null,
        assigneeId: null,
      });
    });
  });
});

describe("needsHuman", () => {
  it("sets status=Todo, clears delegate, sets assignee=human, posts comment", async () => {
    const result = await needsHuman("AI-100", "Matt Henry", { comment: "Need your input." });
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "Need your input.");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-todo",
      delegateId: null,
      assigneeId: "user-matt",
    });
    expect(result).toEqual({
      command: "needsHuman",
      issueId: "AI-100",
      state: "Todo",
      delegate: null,
      assignee: "Matt Henry",
      commentPosted: true,
      duplicateBlocked: false,
      duplicateDetails: null,
      rateLimitBlocked: false,
      rateLimitDetails: null,
      commentId: "comment-uuid",
      commentUrl: "https://linear.app/test/comment/comment-uuid",
      commentCreatedAt: "2026-04-26T12:00:00Z",
      commentBodyLength: 4,
      bodyFile: null,
    });
  });

  it("succeeds without comment (emits stderr warning)", async () => {
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await needsHuman("AI-100", "Matt Henry", {});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("no comment provided"));
    spy.mockRestore();
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      stateId: "state-todo",
      delegateId: null,
      assigneeId: "user-matt",
    });
    expect(result.commentPosted).toBe(false);
  });

  it("is idempotent — safe to call multiple times", async () => {
    await needsHuman("AI-100", "Matt Henry", { comment: "First ping." });
    await needsHuman("AI-100", "Matt Henry", { comment: "Second ping." });
    expect(mockAddComment).toHaveBeenCalledTimes(2);
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
  });
});

describe("note", () => {
  it("posts a comment without any state change", async () => {
    const result = await note("AI-100", { comment: "Follow-up note." });
    expect(mockAddComment).toHaveBeenCalledWith("issue-1", "Follow-up note.");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result).toEqual({ issueId: "AI-100", commentPosted: true, duplicateBlocked: false, duplicateDetails: null, rateLimitBlocked: false, rateLimitDetails: null, commentId: "comment-uuid", commentUrl: "https://linear.app/test/comment/comment-uuid", commentCreatedAt: "2026-04-26T12:00:00Z", commentBodyLength: 4, bodyFile: null });
  });

  it("works on a Done ticket", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-done", name: "Done", type: "completed" },
    });
    const result = await note("AI-100", { comment: "Late clarification." });
    expect(mockAddComment).toHaveBeenCalledWith("issue-1", "Late clarification.");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result.commentPosted).toBe(true);
  });

  it("reads comment from file", async () => {
    jest.spyOn(fs, "readFile").mockResolvedValueOnce("File note content");
    const result = await note("AI-100", { commentFile: "/path/to/note.md" });
    expect(mockAddComment).toHaveBeenCalledWith("issue-1", "File note content");
    expect(result.commentPosted).toBe(true);
  });

  it("throws when no comment is provided", async () => {
    await expect(note("AI-100", {})).rejects.toThrow("non-empty comment");
  });

  it("throws when comment is whitespace-only", async () => {
    await expect(note("AI-100", { comment: "   " })).rejects.toThrow("non-empty comment");
  });
});

describe("undelegate", () => {
  it("clears delegate and assignee without changing state", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      delegate: { id: "user-wikiwizard", name: "WikiWizard" },
      assignee: { id: "user-matt", name: "Matt Henry" },
    });
    mockUpdateIssue.mockResolvedValue({
      ...baseIssue,
      delegate: null,
      assignee: null,
    });

    const result = await undelegate("AI-100", { comment: "Releasing this for pickup." });

    expect(mockAddComment).toHaveBeenCalledWith("issue-1", "Releasing this for pickup.");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      delegateId: null,
      assigneeId: null,
    });
    expect(mockFindSemanticState).not.toHaveBeenCalled();
    expect(result.state).toBe("Todo");
    expect(result.delegate).toBeNull();
    expect(result.assignee).toBeNull();
  });
});

describe("historyToTimelineEvents", () => {
  it("returns empty array for empty/undefined input", () => {
    expect(historyToTimelineEvents([])).toEqual([]);
    expect(historyToTimelineEvents(undefined)).toEqual([]);
  });

  it("emits one event per field change", () => {
    const history: IssueHistory[] = [
      {
        createdAt: "2026-04-26T12:00:00Z",
        actor: { name: "Charles" },
        fromState: { name: "Todo" },
        toState: { name: "In Progress" },
        fromAssignee: null,
        toAssignee: { name: "Igor" },
        fromDelegate: null,
        toDelegate: null,
        fromPriority: null,
        toPriority: null,
      },
    ];
    const events = historyToTimelineEvents(history);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("state");
    expect(events[0].from).toBe("Todo");
    expect(events[0].to).toBe("In Progress");
    expect(events[1].type).toBe("assignee");
    expect(events[1].from).toBe(null);
    expect(events[1].to).toBe("Igor");
  });

  it("preserves chronological order", () => {
    const history: IssueHistory[] = [
      {
        createdAt: "2026-04-26T14:00:00Z",
        actor: { name: "Igor" },
        fromState: { name: "In Progress" },
        toState: { name: "Done" },
        fromAssignee: null, toAssignee: null,
        fromDelegate: null, toDelegate: null,
        fromPriority: null, toPriority: null,
      },
      {
        createdAt: "2026-04-26T12:00:00Z",
        actor: { name: "Charles" },
        fromState: { name: "Todo" },
        toState: { name: "In Progress" },
        fromAssignee: null, toAssignee: null,
        fromDelegate: null, toDelegate: null,
        fromPriority: null, toPriority: null,
      },
    ];
    const events = historyToTimelineEvents(history);
    expect(events[0].to).toBe("In Progress");
    expect(events[1].to).toBe("Done");
  });

  it("skips history records with no relevant changes", () => {
    const history: IssueHistory[] = [
      {
        createdAt: "2026-04-26T12:00:00Z",
        actor: { name: "Someone" },
        fromState: null, toState: null,
        fromAssignee: null, toAssignee: null,
        fromDelegate: null, toDelegate: null,
        fromPriority: null, toPriority: null,
      },
    ];
    expect(historyToTimelineEvents(history)).toEqual([]);
  });
});

describe("inline comment safety warnings", () => {
  it("warns when an inline comment looks stripped by shell command substitution", async () => {
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    await handoffWork("AI-100", "Charles (CTO)", { comment: "removed  from the vault" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("looks like shell command-substitution"));
    spy.mockRestore();
  });

  it("does not warn for comment-file bodies", async () => {
    const spy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const readSpy = jest.spyOn(fs, "readFile").mockResolvedValue("removed `personal/expense-tally.md` from the vault");
    await handoffWork("AI-100", "Charles (CTO)", { commentFile: "/tmp/comment.md" });
    expect(spy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    spy.mockRestore();
  });
});
