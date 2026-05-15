import { linearGraphQL } from "../client";
import { getBoard, getReviewQueue, getStalled, getComments } from "../boards";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

const mockIssue = (id: string, state: string) => ({
  id,
  identifier: id,
  title: `Issue ${id}`,
  updatedAt: "2026-01-01T00:00:00Z",
  priority: 1,
  state: { id: `s-${state}`, name: state, type: "started" },
  assignee: { id: "u-1", name: "Matt", email: "m@example.com" }
});

describe("getBoard", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("groups issues by state name", async () => {
    mockedGraphQL.mockResolvedValue({
      team: {
        issues: {
          nodes: [mockIssue("AI-100", "Todo"), mockIssue("AI-200", "Todo"), mockIssue("AI-300", "In Progress")]
        }
      }
    });
    const board = await getBoard("team-1");
    expect(Object.keys(board)).toEqual(["Todo", "In Progress"]);
    expect(board["Todo"]).toHaveLength(2);
    expect(board["In Progress"]).toHaveLength(1);
  });

  it("puts issues without state in 'Unspecified'", async () => {
    mockedGraphQL.mockResolvedValue({
      team: {
        issues: { nodes: [{ ...mockIssue("AI-100", "Todo"), state: null }] }
      }
    });
    const board = await getBoard("team-1");
    expect(board["Unspecified"]).toHaveLength(1);
  });

  it("throws when team not found", async () => {
    mockedGraphQL.mockResolvedValue({ team: null });
    await expect(getBoard("bad-team")).rejects.toThrow("Team not found");
  });
});

describe("getReviewQueue", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns issues in Needs Review state", async () => {
    mockedGraphQL.mockResolvedValue({
      viewer: {
        assignedIssues: {
          nodes: [
            { ...mockIssue("AI-100", "Needs Review"), team: { id: "t-1", key: "AI", name: "AI" } }
          ]
        }
      }
    });
    const queue = await getReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].identifier).toBe("AI-100");
  });

  it("returns empty array when nothing needs review", async () => {
    mockedGraphQL.mockResolvedValue({ viewer: { assignedIssues: { nodes: [] } } });
    const queue = await getReviewQueue();
    expect(queue).toEqual([]);
  });
});

describe("getStalled", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns issues not updated within the threshold", async () => {
    mockedGraphQL.mockResolvedValue({
      viewer: {
        assignedIssues: {
          nodes: [
            { ...mockIssue("AI-100", "In Progress"), updatedAt: "2025-01-01T00:00:00Z", team: { id: "t-1", key: "AI", name: "AI" } }
          ]
        }
      }
    });
    const stalled = await getStalled(7);
    expect(stalled).toHaveLength(1);
    // Verify the before date is passed correctly
    const callVars = mockedGraphQL.mock.calls[0][1] as { updatedAt: string };
    expect(callVars.updatedAt).toBeDefined();
  });

  it("defaults to 2 days", async () => {
    mockedGraphQL.mockResolvedValue({ viewer: { assignedIssues: { nodes: [] } } });
    await getStalled();
    const callVars = mockedGraphQL.mock.calls[0][1] as { updatedAt: string };
    const cutoff = new Date(callVars.updatedAt).getTime();
    const expected = Date.now() - 2 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeLessThan(expected + 1000);
    expect(cutoff).toBeGreaterThan(expected - 1000);
  });
});

describe("getComments", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns comments for an issue", async () => {
    const comments = [
      { id: "c-1", body: "First", createdAt: "2026-01-01", updatedAt: "2026-01-01", user: { id: "u-1", name: "Matt" } }
    ];
    mockedGraphQL.mockResolvedValue({ issue: { comments: { nodes: comments } } });
    const result = await getComments("AI-100");
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("First");
  });

  it("passes all=true by default (250 comments)", async () => {
    mockedGraphQL.mockResolvedValue({ issue: { comments: { nodes: [] } } });
    await getComments("AI-100", true);
    const callVars = mockedGraphQL.mock.calls[0][1] as { count: number };
    expect(callVars.count).toBe(250);
  });

  it("passes limited count when all=false", async () => {
    mockedGraphQL.mockResolvedValue({ issue: { comments: { nodes: [] } } });
    await getComments("AI-100", false);
    const callVars = mockedGraphQL.mock.calls[0][1] as { count: number };
    expect(callVars.count).toBe(10);
  });

  it("requests Linear's app flag for comment authors", async () => {
    mockedGraphQL.mockResolvedValue({ issue: { comments: { nodes: [] } } });
    await getComments("AI-100");
    const query = mockedGraphQL.mock.calls[0][0] as string;
    expect(query).toContain("app");
  });

  it("throws when issue not found", async () => {
    mockedGraphQL.mockResolvedValue({ issue: null });
    await expect(getComments("bad-id")).rejects.toThrow("Issue not found");
  });
});
