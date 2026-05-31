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
  mockGetSelfUser.mockResolvedValue({ id: "user-charles", name: "Charles (CTO)", email: "charles@test.com" });
  mockUpdateIssue.mockResolvedValue({ ...baseIssue, state: managingState } as never);
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
  it("transitions to Managing and delegates to self", async () => {
    const result = await manageWork("AI-100");
    expect(mockFindSemanticState).toHaveBeenCalledWith("team-1", "managing");
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-100",
      expect.objectContaining({
        stateId: "state-managing",
        delegateId: "user-charles",
        assigneeId: null,
      }),
    );
    expect(result.state).toBe("Managing");
    expect(result.delegate).toBe("Charles (CTO)");
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
      expect.objectContaining({ delegateId: "user-charles", assigneeId: null }),
    );
    expect(result.delegate).toBe("Charles (CTO)");
  });

  it("clears assignee when already in Managing but assignee is set", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: managingState,
      assignee: { id: "user-matt", name: "Matt Henry" },
      delegate: { id: "user-charles", name: "Charles (CTO)" },
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
      delegate: { id: "user-charles", name: "Charles (CTO)" },
    } as never);
    const result = await manageWork("AI-100");
    const stateUpdates = mockUpdateIssue.mock.calls.filter((c) => "stateId" in (c[1] ?? {}));
    expect(stateUpdates).toHaveLength(0);
    expect(result.state).toBe("Managing");
    expect(result.delegate).toBe("Charles (CTO)");
  });
});
