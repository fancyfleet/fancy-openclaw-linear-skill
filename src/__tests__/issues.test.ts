import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { linearGraphQL } from "../client";
import {
  getIssue,
  createIssue,
  updateIssue,
  addComment,
  buildProsemirrorBody,
  getMyIssues,
  getMyNewIssues,
  getMyQueue,
  findUserByName,
  resolveUserWithHints,
  rewriteIssueLinks,
  getWorkspaceUrlKey,
  _resetWorkspaceUrlKeyCache
} from "../issues";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

jest.mock("../auth", () => ({
  getSelfUser: jest.fn()
    .mockResolvedValue({ id: "self-1", name: "Test Bot", email: "bot@test.com" })
}));

jest.mock("../states", () => ({
  findSemanticState: jest.fn().mockResolvedValue({ id: "state-todo-1", name: "To Do", type: "unstarted", color: "#aaa", position: 0 })
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

// Silence stderr warnings during tests
beforeEach(() => {
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  (process.stderr.write as jest.Mock).mockRestore();
});

const mockIssue = {
  id: "issue-uuid-1",
  identifier: "AI-100",
  title: "Test issue",
  description: "A test",
  priority: 1,
  url: "https://linear.app/test/AI-100",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-1", name: "Todo", type: "unstarted", color: "#ccc", position: 0 },
  assignee: { id: "user-1", name: "Matt", email: "matt@example.com" },
  delegate: null,
  project: { id: "proj-1", name: "Test Project" },
  projectMilestone: { id: "milestone-1", name: "Sprint 1", description: null, targetDate: "2026-02-01" },
  labels: { nodes: [{ id: "label-1", name: "bug", color: "red" }] },
  parent: null,
  children: { nodes: [] },
  relations: { nodes: [] },
  comments: { nodes: [] }
};

describe("getIssue", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("fetches issue by UUID", async () => {
    mockedGraphQL.mockResolvedValue({ issue: mockIssue });
    const result = await getIssue("issue-uuid-1");
    expect(result.identifier).toBe("AI-100");
    expect(result.milestone?.name).toBe("Sprint 1");
    expect(result.labels).toEqual([{ id: "label-1", name: "bug", color: "red" }]);
  });

  it("fetches issue by identifier (e.g. AI-100)", async () => {
    mockedGraphQL.mockResolvedValue({ issues: { nodes: [mockIssue] } });
    const result = await getIssue("AI-100");
    expect(result.identifier).toBe("AI-100");
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("IssueByIdentifier"),
      { teamKey: "AI", number: 100 }
    );
  });

  it("throws when issue not found by UUID", async () => {
    mockedGraphQL.mockResolvedValue({ issue: null });
    await expect(getIssue("nonexistent-uuid")).rejects.toThrow("Issue not found");
  });

  it("throws when issue not found by identifier", async () => {
    mockedGraphQL.mockResolvedValue({ issues: { nodes: [] } });
    await expect(getIssue("ZZ-999")).rejects.toThrow("Issue not found");
  });
});

describe("createIssue", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("creates issue and returns fetched result", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ issueCreate: { success: true, issue: { id: "new-id", identifier: "AI-200", title: "New" } } })
      .mockResolvedValueOnce({ issue: { ...mockIssue, id: "new-id", identifier: "AI-200" } });

    const result = await createIssue({ teamId: "team-1", title: "New issue" });
    expect(result.identifier).toBe("AI-200");
    expect(mockedGraphQL).toHaveBeenCalledTimes(2);
  });

  it("throws when mutation fails", async () => {
    mockedGraphQL.mockResolvedValue({ issueCreate: { success: false, issue: null } });
    await expect(createIssue({ teamId: "team-1", title: "Fail" })).rejects.toThrow("issueCreate mutation failed");
  });
});

describe("updateIssue", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    _resetWorkspaceUrlKeyCache();
  });

  it("updates issue and returns fetched result", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ issueUpdate: { success: true, issue: { id: "issue-uuid-1" } } })
      .mockResolvedValueOnce({ issue: { ...mockIssue, title: "Updated" } });

    const result = await updateIssue("issue-uuid-1", { title: "Updated" });
    expect(result.title).toBe("Updated");
    expect(mockedGraphQL).not.toHaveBeenCalledWith(expect.stringContaining("descriptionData"), expect.anything());
  });

  it("rewrites bare identifiers in description before posting", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ organization: { urlKey: "myorg" } })
      .mockResolvedValueOnce({ issueUpdate: { success: true, issue: { id: "issue-uuid-1" } } })
      .mockResolvedValueOnce({ issue: mockIssue });

    await updateIssue("issue-uuid-1", { description: "See AI-100 for context." });
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("UpdateIssue"),
      expect.objectContaining({
        input: expect.objectContaining({
          description: "See [AI-100](https://linear.app/myorg/issue/AI-100) for context."
        })
      })
    );
  });

  it("throws when update mutation fails", async () => {
    mockedGraphQL.mockResolvedValue({ issueUpdate: { success: false, issue: null } });
    await expect(updateIssue("issue-uuid-1", { title: "Fail" })).rejects.toThrow("issueUpdate mutation failed");
  });
});

describe("buildProsemirrorBody", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    _resetWorkspaceUrlKeyCache();
  });

  it("returns null when text has no issue identifiers", async () => {
    const result = await buildProsemirrorBody("plain text with no refs");
    expect(result).toBeNull();
  });

  it("returns null when no identifiers resolve", async () => {
    mockedGraphQL.mockResolvedValue({ issues: { nodes: [] } });
    const result = await buildProsemirrorBody("See FAKE-999 for context.");
    expect(result).toBeNull();
  });

  it("builds prosemirror doc with issueMention nodes for resolved identifiers", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({
        issues: { nodes: [{ id: "uuid-424", identifier: "AI-424", title: "Issue references in Linear" }] }
      })
      .mockResolvedValueOnce({ organization: { urlKey: "fancymatt" } });

    const result = await buildProsemirrorBody("See AI-424 for context.");
    expect(result).not.toBeNull();
    const doc = result as any;
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(1);
    const para = doc.content[0];
    expect(para.type).toBe("paragraph");
    expect(para.content).toHaveLength(3);
    expect(para.content[0]).toEqual({ type: "text", text: "See " });
    expect(para.content[1].type).toBe("issueMention");
    expect(para.content[1].attrs.label).toBe("AI-424");
    expect(para.content[1].attrs.id).toBe("uuid-424");
    expect(para.content[1].attrs.title).toBe("Issue references in Linear");
    expect(para.content[1].attrs.href).toContain("AI-424");
    expect(para.content[2]).toEqual({ type: "text", text: " for context." });
  });

  it("skips identifiers inside code blocks", async () => {
    mockedGraphQL.mockResolvedValue({
      issues: { nodes: [{ id: "uuid-424", identifier: "AI-424", title: "Test" }] }
    });
    const result = await buildProsemirrorBody("Check this: `AI-424`");
    expect(result).toBeNull();
  });

  it("handles multiple identifiers in one line", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({
        issues: { nodes: [{ id: "uuid-424", identifier: "AI-424", title: "First issue" }] }
      })
      .mockResolvedValueOnce({
        issues: { nodes: [{ id: "uuid-100", identifier: "AI-100", title: "Second issue" }] }
      })
      .mockResolvedValueOnce({ organization: { urlKey: "fancymatt" } });

    const result = await buildProsemirrorBody("See AI-424 and AI-100 together.");
    const doc = result as any;
    const mentions = doc.content[0].content.filter((n: any) => n.type === "issueMention");
    expect(mentions).toHaveLength(2);
    expect(mentions[0].attrs.label).toBe("AI-424");
    expect(mentions[1].attrs.label).toBe("AI-100");
  });
});

describe("addComment", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    _resetWorkspaceUrlKeyCache();
  });

  it("posts comment via body (Markdown) path", async () => {
    mockedGraphQL.mockResolvedValue({
      commentCreate: { success: true, comment: { id: "c-1", body: "Hello", createdAt: "2026-04-26T12:00:00Z", url: "https://linear.app/test/issue/AI-100#comment-c-1" } }
    });
    const result = await addComment("issue-1", "Hello");
    expect(result.body).toBe("Hello");
    expect(result.issueId).toBe("issue-1");
    expect(result.commentId).toBe("c-1");
    expect(result.commentUrl).toBe("https://linear.app/test/issue/AI-100#comment-c-1");
    expect(result.commentCreatedAt).toBe("2026-04-26T12:00:00Z");
    expect(result.commentBodyLength).toBe(5);
    // Should send body, never bodyData
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("$body: String!"),
      expect.objectContaining({ body: "Hello" })
    );
    expect(mockedGraphQL).not.toHaveBeenCalledWith(expect.stringContaining("bodyData"), expect.anything());
  });

  it("rewrites bare identifiers to markdown links before posting", async () => {
    // buildProsemirrorBody tries getIssue(AI-424) first → fails (no issue data in mock)
    // Then falls through to Markdown rewrite path
    // getWorkspaceUrlKey() → returns urlKey
    // Then commentCreate with rewritten Markdown body
    mockedGraphQL
      .mockResolvedValueOnce({ issues: { nodes: [] } })        // getIssue(AI-424) fails — no match
      .mockResolvedValueOnce({ organization: { urlKey: "myorg" } }) // getWorkspaceUrlKey
      .mockResolvedValueOnce({
        commentCreate: {
          success: true,
          comment: {
            id: "c-2",
            body: "See [AI-424](https://linear.app/myorg/issue/AI-424) for context.",
            createdAt: "2026-04-26T12:01:00Z",
            url: "https://linear.app/myorg/issue/AI-424#comment-c-2",
          },
        },
      });
    const result = await addComment("issue-1", "See AI-424 for context.");
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("$body: String!"),
      expect.objectContaining({ body: "See [AI-424](https://linear.app/myorg/issue/AI-424) for context." })
    );
    expect(result.commentId).toBe("c-2");
  });

  it("unescapes literal \\n sequences", async () => {
    mockedGraphQL.mockResolvedValue({
      commentCreate: { success: true, comment: { id: "c-3", body: "line1\nline2", createdAt: "2026-04-26T12:02:00Z", url: "https://linear.app/test/issue/AI-100#comment-c-3" } }
    });
    const result = await addComment("issue-1", "line1\\nline2");
    expect(result.body).toBe("line1\nline2");
    expect(result.commentUrl).toBe("https://linear.app/test/issue/AI-100#comment-c-3");
    expect(result.commentBodyLength).toBe(11);
  });

  it("crashes on undefined body (known bug: guard runs after .replace)", async () => {
    await expect(addComment("issue-1", undefined as any)).rejects.toThrow("Cannot read properties of undefined");
  });

  it("throws when mutation fails", async () => {
    mockedGraphQL.mockResolvedValue({
      commentCreate: { success: false, comment: null }
    });
    await expect(addComment("issue-1", "Hello")).rejects.toThrow("Failed to create comment");
  });
});

describe("getMyIssues", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns all assigned issues without filter", async () => {
    mockedGraphQL.mockResolvedValue({
      viewer: { assignedIssues: { nodes: [mockIssue] } }
    });
    const issues = await getMyIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe("AI-100");
  });

  it("filters by state names", async () => {
    mockedGraphQL.mockResolvedValue({
      viewer: { assignedIssues: { nodes: [mockIssue] } }
    });
    const issues = await getMyIssues(["Todo", "In Progress"]);
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("$stateNames"),
      { stateNames: ["Todo", "In Progress"] }
    );
  });
});

describe("getMyNewIssues", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("defaults to 24h window", async () => {
    mockedGraphQL.mockResolvedValue({
      viewer: { assignedIssues: { nodes: [] } }
    });
    await getMyNewIssues();
    const callVars = mockedGraphQL.mock.calls[0][1] as { updatedAt: string };
    const since = new Date(callVars.updatedAt).getTime();
    const now = Date.now();
    expect(now - since).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("accepts custom since date", async () => {
    mockedGraphQL.mockResolvedValue({
      viewer: { assignedIssues: { nodes: [] } }
    });
    await getMyNewIssues("2026-01-01T00:00:00Z");
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { updatedAt: "2026-01-01T00:00:00Z" }
    );
  });
});

describe("getMyQueue", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns issues sorted by priority then updatedAt", async () => {
    mockedGraphQL.mockResolvedValue({
      issues: {
        nodes: [
          { ...mockIssue, identifier: "AI-300", priority: 2, updatedAt: "2026-01-02T00:00:00Z", state: { name: "Todo", type: "unstarted" } },
          { ...mockIssue, identifier: "AI-100", priority: 0, updatedAt: "2026-01-05T00:00:00Z", state: { name: "In Progress", type: "started" } },
          { ...mockIssue, identifier: "AI-200", priority: 1, updatedAt: "2026-01-03T00:00:00Z", state: { name: "Todo", type: "unstarted" } }
        ]
      }
    });
    const queue = await getMyQueue();
    expect(queue.map(i => i.identifier)).toEqual(["AI-200", "AI-300", "AI-100"]);
  });

  it("excludes started states and Backlog server-side via GraphQL filter", async () => {
    mockedGraphQL.mockResolvedValue({
      issues: {
        nodes: [
          { ...mockIssue, identifier: "AI-200", state: { name: "Todo", type: "unstarted" } }
        ]
      }
    });
    await getMyQueue();
    const callArgs = mockedGraphQL.mock.calls[0][0] as string;
    expect(callArgs).toContain('nin: ["completed", "canceled", "started"]');
    expect(callArgs).toContain('name: { neq: "Backlog" }');
  });

  it("can include Backlog with explicit opt-in", async () => {
    mockedGraphQL.mockResolvedValue({
      issues: {
        nodes: [
          { ...mockIssue, identifier: "AI-200", state: { name: "Backlog", type: "backlog" } }
        ]
      }
    });
    await getMyQueue(undefined, { includeBacklog: true });
    const callArgs = mockedGraphQL.mock.calls[0][0] as string;
    expect(callArgs).toContain('nin: ["completed", "canceled", "started"]');
    expect(callArgs).not.toContain('name: { neq: "Backlog" }');
  });

  it("filters by project name", async () => {
    mockedGraphQL.mockResolvedValue({
      issues: {
        nodes: [
          { ...mockIssue, identifier: "AI-100", project: { id: "p1", name: "Alpha" }, state: { name: "Todo", type: "unstarted" } },
          { ...mockIssue, identifier: "AI-200", project: { id: "p2", name: "Beta" }, state: { name: "Todo", type: "unstarted" } }
        ]
      }
    });
    const queue = await getMyQueue("Alpha");
    expect(queue).toHaveLength(1);
    expect(queue[0].identifier).toBe("AI-100");
  });
});

describe("findUserByName", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("finds user by exact name match (case-insensitive)", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-1", name: "Charles (CTO)", email: "c@example.com" }] }
    });
    const user = await findUserByName("charles (cto)");
    expect(user.id).toBe("u-1");
  });

  it("returns single result when no exact match", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-2", name: "Matt Henry", email: "m@example.com" }] }
    });
    const user = await findUserByName("matt");
    expect(user.id).toBe("u-2");
  });

  it("throws when no users found", async () => {
    mockedGraphQL.mockResolvedValue({ users: { nodes: [] } });
    await expect(findUserByName("nobody")).rejects.toThrow("Could not uniquely resolve");
  });

  it("throws when multiple users and no exact match", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [{ id: "u-1", name: "Matt A" }, { id: "u-2", name: "Matt B" }] }
    });
    await expect(findUserByName("Matt")).rejects.toThrow("Could not uniquely resolve");
  });
});

describe("rewriteIssueLinks", () => {
  const KEY = "fancymatt";

  it("returns text unchanged when no identifiers present", () => {
    const text = "This is a plain comment with no refs.";
    expect(rewriteIssueLinks(text, KEY)).toBe(text);
  });

  it("rewrites a single bare identifier to a markdown link", () => {
    const result = rewriteIssueLinks("See AI-424 for context.", KEY);
    expect(result).toBe("See [AI-424](https://linear.app/fancymatt/issue/AI-424) for context.");
  });

  it("rewrites multiple identifiers", () => {
    const result = rewriteIssueLinks("Work on AI-100 and AI-200 together.", KEY);
    expect(result).toBe(
      "Work on [AI-100](https://linear.app/fancymatt/issue/AI-100) and [AI-200](https://linear.app/fancymatt/issue/AI-200) together."
    );
  });

  it("rewrites identifier mid-sentence with surrounding punctuation", () => {
    const result = rewriteIssueLinks("Inaccuracies (FCY-320, LIFE-60): fix now.", KEY);
    expect(result).toBe(
      "Inaccuracies ([FCY-320](https://linear.app/fancymatt/issue/FCY-320), [LIFE-60](https://linear.app/fancymatt/issue/LIFE-60)): fix now."
    );
  });

  it("skips identifier inside fenced code block", () => {
    const text = "See:\n```\nAI-424 in code\n```\nend.";
    expect(rewriteIssueLinks(text, KEY)).toBe(text);
  });

  it("skips identifier inside inline code span", () => {
    const text = "See `AI-424` for details.";
    expect(rewriteIssueLinks(text, KEY)).toBe(text);
  });

  it("skips identifier already inside an existing markdown link", () => {
    const text = "Already linked [AI-424](https://linear.app/fancymatt/issue/AI-424) here.";
    expect(rewriteIssueLinks(text, KEY)).toBe(text);
  });

  it("skips identifier inside a bare URL", () => {
    const text = "See https://linear.app/fancymatt/issue/AI-424 for context.";
    expect(rewriteIssueLinks(text, KEY)).toBe(text);
  });

  it("rewrites identifier outside code fence but not one inside", () => {
    const text = "See AI-100.\n```\nAI-200 in fence\n```\nDone AI-300.";
    const result = rewriteIssueLinks(text, KEY);
    expect(result).toContain("[AI-100](https://linear.app/fancymatt/issue/AI-100)");
    expect(result).toContain("[AI-300](https://linear.app/fancymatt/issue/AI-300)");
    expect(result).toContain("AI-200 in fence");
    expect(result).not.toContain("[AI-200]");
  });
});

describe("getWorkspaceUrlKey", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    _resetWorkspaceUrlKeyCache();
  });

  it("fetches urlKey from organization query", async () => {
    mockedGraphQL.mockResolvedValue({ organization: { urlKey: "testorg" } });
    const key = await getWorkspaceUrlKey();
    expect(key).toBe("testorg");
    expect(mockedGraphQL).toHaveBeenCalledWith(expect.stringContaining("OrganizationUrlKey"));
  });

  it("caches the result on subsequent calls", async () => {
    mockedGraphQL.mockResolvedValue({ organization: { urlKey: "testorg" } });
    await getWorkspaceUrlKey();
    await getWorkspaceUrlKey();
    expect(mockedGraphQL).toHaveBeenCalledTimes(1);
  });
});

describe("resolveUserWithHints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock: no users found
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [] },
    });
  });

  test("unknown name in create context includes display-name hint", async () => {
    await expect(resolveUserWithHints("Nonexistent Person", "create"))
      .rejects.toThrow(/Tip: use 'linear create --assignee "Display Name"'/);
  });

  test("unknown name in handoff-work context suggests needs-human", async () => {
    await expect(resolveUserWithHints("Matt", "handoff-work"))
      .rejects.toThrow(/If Matt is a human, consider using 'needs-human'/);
  });

  test("unknown name without context returns base error", async () => {
    await expect(resolveUserWithHints("Nobody"))
      .rejects.toThrow(/Could not uniquely resolve/);
    // Should NOT include create-specific or handoff-specific hints
    await expect(resolveUserWithHints("Nobody"))
      .rejects.not.toThrow(/Tip: use 'linear create/);
  });
});
