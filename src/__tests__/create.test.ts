import { linearGraphQL } from "../client";
import { createIssue, resolveUserRef, resolveUserWithHints } from "../issues";
import { findSemanticState } from "../states";
import { normalizeCliDescription } from "../utils";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;
const mockedFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;

// Silence stderr warnings during tests
beforeEach(() => {
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  (process.stderr.write as jest.Mock).mockRestore();
});

describe("resolveUserRef", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("passes through a UUID directly without calling API", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = await resolveUserRef(uuid);
    expect(result).toBe(uuid);
    expect(mockedGraphQL).not.toHaveBeenCalled();
  });

  it("passes through a UUID (uppercase prefix variant)", async () => {
    const uuid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    const result = await resolveUserRef(uuid);
    expect(result).toBe(uuid);
    expect(mockedGraphQL).not.toHaveBeenCalled();
  });

  it("resolves a name to user ID via findUserByName", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-1", name: "Charles (CTO)", email: "c@example.com" }] }
    });
    const result = await resolveUserRef("Charles (CTO)");
    expect(result).toBe("u-1");
    expect(mockedGraphQL).toHaveBeenCalledTimes(1);
  });

  it("resolves a partial name to user ID", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-2", name: "Matt Henry", email: "m@example.com" }] }
    });
    const result = await resolveUserRef("matt");
    expect(result).toBe("u-2");
  });

  it("throws when name is not found", async () => {
    mockedGraphQL.mockResolvedValue({ users: { nodes: [] } });
    await expect(resolveUserRef("nobody")).rejects.toThrow("Could not uniquely resolve");
  });

  it("throws when name matches multiple users", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-1", name: "Matt A" }, { id: "u-2", name: "Matt B" }] }
    });
    await expect(resolveUserRef("Matt")).rejects.toThrow("Could not uniquely resolve");
  });

  it("does not treat a short string as UUID", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-1", name: "Short Name", email: "s@example.com" }] }
    });
    const result = await resolveUserRef("short");
    expect(result).toBe("u-1");
    expect(mockedGraphQL).toHaveBeenCalledTimes(1);
  });
});

describe("resolveUserWithHints (UUID passthrough)", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("passes through a UUID directly without calling API", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = await resolveUserWithHints(uuid);
    expect(result.id).toBe(uuid);
    expect(mockedGraphQL).not.toHaveBeenCalled();
  });

  it("resolves a name via findUserByName when not a UUID", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-1", name: "Charles (CTO)", email: "c@example.com" }] }
    });
    const result = await resolveUserWithHints("Charles (CTO)");
    expect(result.id).toBe("u-1");
    expect(mockedGraphQL).toHaveBeenCalledTimes(1);
  });

  it("throws with hints when name not found", async () => {
    mockedGraphQL.mockResolvedValue({ users: { nodes: [] } });
    await expect(resolveUserWithHints("nobody")).rejects.toThrow("Could not uniquely resolve");
  });
});

describe("create description/delegate handling", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockedFindSemanticState.mockReset();
    mockedFindSemanticState.mockResolvedValue({
      id: "state-todo",
      name: "Todo",
      type: "unstarted",
      color: "#000000",
      position: 0
    });
  });

  it("normalizes literal escaped newlines in CLI descriptions", () => {
    expect(normalizeCliDescription("# Heading\\n\\nBody\\r\\nNext")).toBe("# Heading\n\nBody\nNext");
  });

  it("sends create-time delegateId as the resolved ID string", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ issueCreate: { success: true, issue: { id: "00000000-0000-4000-8000-000000000001", identifier: "AI-999", title: "Test" } } })
      .mockResolvedValueOnce({
        issue: {
          id: "00000000-0000-4000-8000-000000000001",
          identifier: "AI-999",
          title: "Test",
          description: "# Heading\n\nBody",
          url: "https://linear.app/fancymatt/issue/AI-999/test",
          createdAt: "2026-05-02T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
          priority: 2,
          state: { id: "state-todo", name: "Todo", type: "unstarted" },
          assignee: null,
          team: { id: "team-1", key: "AI", name: "AI" },
          delegate: { id: "user-charles", name: "Charles (CTO)" },
          project: null,
          projectMilestone: null,
          labels: { nodes: [] },
          relations: { nodes: [] },
          comments: { nodes: [] },
          children: { nodes: [] }
        }
      });

    await createIssue({
      teamId: "team-1",
      title: "Test",
      description: "# Heading\n\nBody",
      delegateId: "user-charles"
    });

    expect(mockedGraphQL).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("issueCreate"),
      expect.objectContaining({
        input: expect.objectContaining({
          delegateId: "user-charles",
          description: "# Heading\n\nBody"
        })
      })
    );
  });
});

describe("create default state (AI-1097)", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockedFindSemanticState.mockReset();
  });

  const fetchIssueResponse = {
    issue: {
      id: "00000000-0000-4000-8000-0000000000aa",
      identifier: "AI-1000",
      title: "Default state test",
      description: "",
      url: "https://linear.app/fancymatt/issue/AI-1000/default-state-test",
      createdAt: "2026-05-26T00:00:00Z",
      updatedAt: "2026-05-26T00:00:00Z",
      priority: 0,
      state: { id: "state-todo", name: "Todo", type: "unstarted" },
      assignee: null,
      team: { id: "team-ai", key: "AI", name: "AI" },
      delegate: null,
      project: null,
      projectMilestone: null,
      labels: { nodes: [] },
      relations: { nodes: [] },
      comments: { nodes: [] },
      children: { nodes: [] }
    }
  };

  it("defaults to the team's To Do state when no stateId and no project are provided", async () => {
    mockedFindSemanticState.mockResolvedValue({
      id: "state-todo",
      name: "Todo",
      type: "unstarted",
      color: "#000000",
      position: 1
    });
    mockedGraphQL
      .mockResolvedValueOnce({ issueCreate: { success: true, issue: { id: "00000000-0000-4000-8000-0000000000aa", identifier: "AI-1000", title: "Default state test" } } })
      .mockResolvedValueOnce(fetchIssueResponse);

    await createIssue({
      teamId: "team-ai",
      title: "Default state test"
    });

    expect(mockedFindSemanticState).toHaveBeenCalledWith("team-ai", "todo");
    expect(mockedGraphQL).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("issueCreate"),
      expect.objectContaining({
        input: expect.objectContaining({
          stateId: "state-todo"
        })
      })
    );
  });

  it("respects an explicit stateId and skips the To Do lookup", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ issueCreate: { success: true, issue: { id: "00000000-0000-4000-8000-0000000000bb", identifier: "AI-1001", title: "Explicit backlog" } } })
      .mockResolvedValueOnce(fetchIssueResponse);

    await createIssue({
      teamId: "team-ai",
      title: "Explicit backlog",
      stateId: "state-backlog"
    });

    expect(mockedFindSemanticState).not.toHaveBeenCalled();
    expect(mockedGraphQL).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("issueCreate"),
      expect.objectContaining({
        input: expect.objectContaining({
          stateId: "state-backlog"
        })
      })
    );
  });

  it("warns and falls through if the team's To Do state cannot be resolved", async () => {
    mockedFindSemanticState.mockRejectedValue(new Error("No workflow state found"));
    mockedGraphQL
      .mockResolvedValueOnce({ issueCreate: { success: true, issue: { id: "00000000-0000-4000-8000-0000000000cc", identifier: "AI-1002", title: "No todo state" } } })
      .mockResolvedValueOnce(fetchIssueResponse);

    await createIssue({
      teamId: "team-ai",
      title: "No todo state"
    });

    const createCall = mockedGraphQL.mock.calls[0];
    const input = (createCall[1] as { input: Record<string, unknown> }).input;
    expect(input.stateId).toBeUndefined();
  });
});
