import { getSelfUser } from "../auth";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import { manageWork } from "../semantic";

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

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockFindUserByName = findUserByName as jest.MockedFunction<typeof findUserByName>;

const managingState = { id: "state-managing", name: "Managing", type: "unstarted" };

const baseIssue: any = {
  id: "issue-1",
  identifier: "AI-100",
  title: "Some stewardship ticket",
  description: "Existing body.",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-todo", name: "Todo", type: "unstarted" },
  assignee: { id: "user-matt", name: "Matt Henry" },
  delegate: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockGetIssue.mockResolvedValue(baseIssue);
  // INF-995: agents are app users. self.app must be true so the INF-907
  // delegate/stateId split fires for the delegate-to-self verbs (manage,
  // consider-work). The old mock omitted `app`, encoding the very bug this
  // ticket fixes (self.app undefined → split skipped → delegate dropped).
  mockGetSelfUser.mockResolvedValue({ id: "user-hanzo", name: "Hanzo (Merge Gate)", email: "hanzo@test.com", app: true });
  const _manageUserMap: Record<string, { id: string; name: string }> = {
    "user-hanzo": { id: "user-hanzo", name: "Hanzo (Merge Gate)" },
    "user-matt": { id: "user-matt", name: "Matt Henry" },
  };
  mockUpdateIssue.mockImplementation(async (_id: string, input: any) => {
    const currentIssue = await mockGetIssue(_id);
    const result: any = { ...currentIssue };
    if (input.stateId !== undefined) result.state = managingState;
    if ("delegateId" in input) {
      result.delegate = input.delegateId === null ? null : _manageUserMap[input.delegateId] ?? null;
    }
    if ("assigneeId" in input) {
      result.assignee = input.assigneeId === null ? null : _manageUserMap[input.assigneeId] ?? currentIssue.assignee;
    }
    return result;
  });
  mockFindSemanticState.mockResolvedValue(managingState);
  mockAddComment.mockResolvedValue({
    commentId: "c1",
    commentUrl: "https://example/c1",
    commentCreatedAt: "2026-01-01T00:00:00Z",
    commentBodyLength: 10,
    body: "hello",
  } as never);
  mockResolveUserWithHints.mockResolvedValue({ id: "user-x", name: "X" } as never);
  mockFindUserByName.mockResolvedValue({ id: "user-x", name: "X" } as never);
});

describe("manageWork", () => {
  it("transitions to Managing and delegates to self in a SEPARATE delegate-only write (INF-995/INF-907)", async () => {
    const result = await manageWork("AI-100");
    expect(mockFindSemanticState).toHaveBeenCalledWith("team-1", "managing");

    // INF-907 split: the state move must NOT bundle the app-user delegate —
    // Linear silently drops a delegate bundled with a stateId (AI-1395). The
    // state write carries stateId (+ assigneeId:null) but no delegateId.
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-100",
      expect.objectContaining({ stateId: "state-managing", assigneeId: null }),
    );
    const stateCall = mockUpdateIssue.mock.calls.find((c) => "stateId" in (c[1] ?? {}));
    expect(stateCall).toBeDefined();
    expect(stateCall![1]).not.toHaveProperty("delegateId");

    // The delegate is written on its own — { delegateId, assigneeId:null }, the
    // Linear-valid persistent shape — never bundled with a stateId.
    const delegateCall = mockUpdateIssue.mock.calls.find(
      (c) => "delegateId" in (c[1] ?? {}) && !("stateId" in (c[1] ?? {})),
    );
    expect(delegateCall).toBeDefined();
    expect(delegateCall![1]).toEqual({ delegateId: "user-hanzo", assigneeId: null });

    expect(result.state).toBe("Managing");
    expect(result.delegate).toBe("Hanzo (Merge Gate)");
  });

  it("writes a Managing-interval marker when --interval is provided and none exists", async () => {
    await manageWork("AI-100", { interval: "2h" });
    const calls = mockUpdateIssue.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // First call: description update
    expect(calls[0][0]).toBe("AI-100");
    expect(calls[0][1].description).toContain("Managing-interval: 2h");
    expect(calls[0][1].description).toContain("Existing body.");
  });

  it("replaces an existing Managing-interval marker", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      description: "Body line.\n\nManaging-interval: 1h\n\nMore body.",
    } as never);
    await manageWork("AI-100", { interval: "30m" });
    const calls = mockUpdateIssue.mock.calls;
    const descriptionUpdate = calls.find((c) => "description" in (c[1] ?? {}));
    expect(descriptionUpdate).toBeDefined();
    const updated = descriptionUpdate![1].description as string;
    expect(updated).toContain("Managing-interval: 30m");
    expect(updated).not.toContain("Managing-interval: 1h");
    expect(updated).toContain("More body.");
  });

  it("does not update the description when --interval is omitted", async () => {
    await manageWork("AI-100");
    const descriptionUpdates = mockUpdateIssue.mock.calls.filter((c) => "description" in (c[1] ?? {}));
    expect(descriptionUpdates).toHaveLength(0);
  });

  it("repairs delegate when already in Managing but delegate is null (AI-1263)", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: managingState,
      assignee: null,
      delegate: null,
    } as never);
    const result = await manageWork("AI-100");
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-100",
      expect.objectContaining({ delegateId: "user-hanzo", assigneeId: null }),
    );
    expect(result.delegate).toBe("Hanzo (Merge Gate)");
  });

  it("clears assignee when already in Managing but assignee is set", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: managingState,
      assignee: { id: "user-matt", name: "Matt Henry" },
      delegate: { id: "user-hanzo", name: "Hanzo (Merge Gate)" },
    } as never);
    await manageWork("AI-100");
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-100",
      expect.objectContaining({ assigneeId: null }),
    );
  });

  it("is a no-op when already in Managing with delegate=self and no assignee", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: managingState,
      assignee: null,
      delegate: { id: "user-hanzo", name: "Hanzo (Merge Gate)" },
    } as never);
    const result = await manageWork("AI-100");
    const stateUpdates = mockUpdateIssue.mock.calls.filter((c) => "stateId" in (c[1] ?? {}));
    expect(stateUpdates).toHaveLength(0);
    expect(result.state).toBe("Managing");
    expect(result.delegate).toBe("Hanzo (Merge Gate)");
  });
});
