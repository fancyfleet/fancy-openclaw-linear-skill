/**
 * AI-2491 — AC 2: `linear read-last-comment <ID>` returns the most recent
 * comment via a strongly-consistent node query.
 *
 * As with readState, the node query `issue(id:)` is the strongly-consistent
 * path; `issues(filter: {...})` is the eventually-consistent connection feed
 * and must not be used.
 */

import { linearGraphQL } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

// `readLastComment` is not implemented yet — resolve at runtime so the failure
// is a legible assertion rather than a ts-jest compile error.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const issuesModule = require("../issues") as Record<string, unknown>;

interface LastComment {
  commentId?: string;
  body?: string;
  author?: string;
  createdAt?: string;
}

type ReadLastComment = (id: string) => Promise<LastComment | null>;

function readLastComment(id: string): Promise<LastComment | null> {
  const fn = issuesModule.readLastComment;
  if (typeof fn !== "function") {
    throw new Error(
      "AI-2491 AC2: expected `readLastComment` to be exported from src/issues.ts — not implemented yet"
    );
  }
  return (fn as ReadLastComment)(id);
}

// Deliberately NOT in chronological order: the oldest comment is first and the
// newest sits in the middle. A naive `nodes[0]` implementation returns the
// wrong comment against this fixture — which is the point.
const OUT_OF_ORDER_COMMENTS = {
  issue: {
    identifier: "AI-2491",
    comments: {
      nodes: [
        {
          id: "c-oldest",
          body: "First comment",
          createdAt: "2026-07-10T09:00:00Z",
          user: { name: "Ai", displayName: "Ai" }
        },
        {
          id: "c-newest",
          body: "Most recent comment",
          createdAt: "2026-07-15T09:00:00Z",
          user: { name: "Ai", displayName: "Ai" }
        },
        {
          id: "c-middle",
          body: "Middle comment",
          createdAt: "2026-07-12T09:00:00Z",
          user: { name: "Ai", displayName: "Ai" }
        }
      ]
    }
  }
};

beforeEach(() => {
  mockedGraphQL.mockReset();
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  (process.stderr.write as jest.Mock).mockRestore();
});

describe("AI-2491: readLastComment (AC 2)", () => {
  it("returns the most recent comment with body, author, createdAt and commentId", async () => {
    mockedGraphQL.mockResolvedValue(OUT_OF_ORDER_COMMENTS);

    const result = await readLastComment("AI-2491");

    expect(result).toMatchObject({
      commentId: "c-newest",
      body: "Most recent comment",
      author: "Ai",
      createdAt: "2026-07-15T09:00:00Z"
    });
  });

  it("selects the newest comment by createdAt even when the feed arrives out of chronological order", async () => {
    mockedGraphQL.mockResolvedValue(OUT_OF_ORDER_COMMENTS);

    const result = await readLastComment("AI-2491");

    // Guards against "take nodes[0]" and "take the last element".
    expect(result?.commentId).toBe("c-newest");
    expect(result?.body).not.toBe("First comment");
    expect(result?.body).not.toBe("Middle comment");
  });

  it("uses the strongly-consistent issue(id:) node query, not the issues(filter:) connection feed", async () => {
    mockedGraphQL.mockResolvedValue(OUT_OF_ORDER_COMMENTS);

    await readLastComment("AI-2491");

    const query = mockedGraphQL.mock.calls[0][0] as string;
    expect(query).toContain("issue(id:");
    expect(query).not.toContain("issues(filter:");
  });

  it("handles the no-comments case gracefully", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: { identifier: "AI-2491", comments: { nodes: [] } }
    });

    // Must not throw, and must not fabricate a comment.
    await expect(readLastComment("AI-2491")).resolves.toBeDefined();

    const result = await readLastComment("AI-2491");
    expect(result?.body ?? null).toBeNull();
  });
});
