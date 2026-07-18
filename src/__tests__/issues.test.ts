import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { linearGraphQL } from "../client";
import {
  getIssue,
  createIssue,
  updateIssue,
  addComment,
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
    mockedGraphQL.mockResolvedValue({ issue: mockIssue });
    const result = await getIssue("AI-100");
    expect(result.identifier).toBe("AI-100");
    // An identifier goes to the same node query a UUID does, verbatim — see
    // inf-29-getissue-node-query.test.ts for why the team+number filter this
    // used to assert had to go.
    expect(mockedGraphQL).toHaveBeenCalledWith(
      expect.stringContaining("issue(id: $id)"),
      { id: "AI-100" }
    );
  });

  it("throws when issue not found by UUID", async () => {
    mockedGraphQL.mockResolvedValue({ issue: null });
    await expect(getIssue("nonexistent-uuid")).rejects.toThrow("Issue not found");
  });

  it("throws when issue not found by identifier", async () => {
    mockedGraphQL.mockResolvedValue({ issue: null });
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
    // getWorkspaceUrlKey() → returns urlKey
    // Then commentCreate with rewritten Markdown body
    mockedGraphQL
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

// AI-2509: a bare ticket ref used to route the comment through a Prosemirror
// bodyData doc built from plain-text nodes, so Linear escaped every Markdown
// character in the body. These cases mirror the ticket's A/B/C repro, with the
// identifier resolving successfully — the condition under which the old
// Prosemirror path actually engaged.
describe("addComment — bare refs preserve surrounding Markdown (AI-2509)", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    _resetWorkspaceUrlKeyCache();
  });

  // Dispatch on the query rather than call order: the unfixed code resolves the
  // identifier first, so an ordered mock queue would run dry and fail the test
  // on mock exhaustion instead of on the escaping it is meant to catch.
  function mockByQuery() {
    mockedGraphQL.mockImplementation(async (query: string) => {
      if (query.includes("organization")) {
        return { organization: { urlKey: "fancymatt" } };
      }
      if (query.includes("issues(")) {
        return {
          issues: {
            nodes: [{ id: "uuid-2498", identifier: "AI-2498", title: "A resolvable issue" }]
          }
        };
      }
      if (query.includes("commentCreate")) {
        return {
          commentCreate: {
            success: true,
            comment: {
              id: "c-md",
              body: "stored",
              createdAt: "2026-07-16T12:00:00Z",
              url: "https://linear.app/fancymatt/issue/AI-2507#comment-c-md"
            }
          }
        };
      }
      throw new Error(`unexpected query: ${query}`);
    });
  }

  function lastCommentBody(): string {
    const call = mockedGraphQL.mock.calls.filter((c) =>
      String(c[0]).includes("commentCreate")
    ).at(-1);
    if (!call) throw new Error("commentCreate was never called");
    return (call[1] as { body: string }).body;
  }

  it("linkifies a bare ref and leaves bold/code spans unescaped", async () => {
    mockByQuery();

    await addComment("issue-1", "**boldD** and `codeD` mentions AI-2498 here");

    const expected =
      "**boldD** and `codeD` mentions [AI-2498](https://linear.app/fancymatt/issue/AI-2498) here";
    expect(lastCommentBody()).toBe(expected);
  });

  it("never sends bodyData for a text comment, even when the ref resolves", async () => {
    mockByQuery();

    await addComment("issue-1", "**boldD** and `codeD` mentions AI-2498 here");

    expect(mockedGraphQL).not.toHaveBeenCalledWith(
      expect.stringContaining("bodyData"),
      expect.anything()
    );
  });

  it("stores case B the same way as the pre-linkified case C", async () => {
    mockByQuery();
    await addComment("issue-1", "**boldD** and `codeD` mentions AI-2498 here");
    const bareRefBody = lastCommentBody();

    mockedGraphQL.mockReset();
    _resetWorkspaceUrlKeyCache();
    mockByQuery();
    await addComment(
      "issue-1",
      "**boldD** and `codeD` mentions [AI-2498](https://linear.app/fancymatt/issue/AI-2498) here"
    );
    const preLinkifiedBody = lastCommentBody();

    expect(bareRefBody).toBe(preLinkifiedBody);
  });

  it("survives a Markdown-heavy round trip without backslash escapes", async () => {
    const body = [
      "## Review brief",
      "",
      "**Status:** blocked on AI-2498",
      "",
      "- `src/issues.ts` — see [the PR](https://github.com/x/y/pull/1)",
      "",
      "```ts",
      "const x = 1; // AI-9999 stays untouched in code",
      "```"
    ].join("\n");

    mockByQuery();

    await addComment("issue-1", body);

    const sent = lastCommentBody();
    expect(sent).not.toContain("\\");
    expect(sent).toContain("## Review brief");
    expect(sent).toContain("**Status:**");
    expect(sent).toContain("`src/issues.ts`");
    expect(sent).toContain("[the PR](https://github.com/x/y/pull/1)");
    expect(sent).toContain("[AI-2498](https://linear.app/fancymatt/issue/AI-2498)");
    // Identifiers inside fenced code stay bare.
    expect(sent).toContain("const x = 1; // AI-9999 stays untouched in code");
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

  it("excludes started states and Backlog/Managing server-side via GraphQL filter", async () => {
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
    expect(callArgs).toContain('name: { nin: ["Backlog", "Managing"] }');
  });

  it("can include Backlog with explicit opt-in but still excludes Managing", async () => {
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
    expect(callArgs).not.toContain('"Backlog", "Managing"');
    expect(callArgs).toContain('name: { neq: "Managing" }');
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
      users: { nodes: [{ id: "u-1", name: "Hanzo (Merge Gate)", email: "c@example.com" }] }
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

  // INF-81: prefix match resolves "signe" → "Signe (UX Researcher)" even when
  // "Penny (UI Designer)" is also returned by the containsIgnoreCase query
  it("resolves by prefix match when substring collision exists (INF-81)", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [
        { id: "u-penny", name: "Penny (UI Designer)" },
        { id: "u-signe", name: "Signe (UX Researcher)" }
      ] }
    });
    const user = await findUserByName("signe");
    expect(user.id).toBe("u-signe");
  });

  // INF-80: slug map resolves colliding prefixes (e.g. `ken` → "Ken (Private Tutor)")
  // without hitting the prefix-ambiguity error. The slug is expanded to the full
  // display name before the API query, so the exact-match path succeeds.
  it("resolves known slug via AGENT_SLUG_MAP before API query", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [
        { id: "u-ken", name: "Ken (Private Tutor)" },
        { id: "u-kenji", name: "Kenji (Game Director)" }
      ] }
    });
    const user = await findUserByName("ken");
    expect(user.id).toBe("u-ken");
    expect(user.name).toBe("Ken (Private Tutor)");
  });

  // INF-80: unknown slug falls through to normal prefix/single-result resolution
  it("falls through to prefix match when slug is not in AGENT_SLUG_MAP", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [
        { id: "u-whoami", name: "Whoami (Mysterious)" }
      ] }
    });
    const user = await findUserByName("whoami");
    expect(user.id).toBe("u-whoami");
  });

  // INF-80: prefix match throws when multiple users share the same prefix
  // and neither is a known slug
  it("throws on multiple prefix matches when no exact match", async () => {
    mockedGraphQL.mockResolvedValue({
      users: { nodes: [
        { id: "u-sig1", name: "Sigourney" },
        { id: "u-sig2", name: "Signe (UX Researcher)" }
      ] }
    });
    await expect(findUserByName("sig")).rejects.toThrow("Could not uniquely resolve");
  });

describe("rewriteIssueLinks", () => {
  const KEY = "fancymatt";

  // AI-2479: HTML comments carry machine-readable markers (e.g. the artifact
  // disclosure record). Link-rewriting inside one silently corrupts the payload:
  // a branch like "feature/AI-2476-gate" becomes
  // "feature/[AI-2476](https://...)-gate", so the recorded branch no longer
  // matches the real one and the guard mis-fires. HTML comments are invisible in
  // rendered Markdown, so a link in there is never useful to a human either.
  it("does not rewrite identifiers inside an HTML comment", () => {
    const marker = '<!-- artifact-disclosure: {"branch":"feature/AI-2476-gate","sha":"b777e17"} -->';
    expect(rewriteIssueLinks(marker, KEY)).toBe(marker);
  });

  it("preserves an HTML-comment marker while still rewriting prose around it", () => {
    const marker = '<!-- artifact-disclosure: {"branch":"feature/AI-2476-gate"} -->';
    const result = rewriteIssueLinks(`Handing AI-2479 to you.\n${marker}`, KEY);
    expect(result).toBe(
      `Handing [AI-2479](https://linear.app/fancymatt/issue/AI-2479) to you.\n${marker}`
    );
  });

  it("does not rewrite inside a multi-line HTML comment", () => {
    const marker = "<!--\n  artifact-disclosure: AI-2476\n-->";
    expect(rewriteIssueLinks(marker, KEY)).toBe(marker);
  });

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
