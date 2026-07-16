/**
 * AI-2494 — `observe-issue` returns the 50 OLDEST comments on tickets with
 * >50 comments, omitting every recent one.
 *
 * Call path: observe-issue -> getIssue (src/issues.ts) -> ISSUE_FIELDS
 * -> src/fragments.ts:139, which requests:
 *
 *     comments(last: 50, orderBy: createdAt)
 *
 * Linear returns `orderBy: createdAt` NEWEST-FIRST, so `last: 50` selects from
 * the tail of that ordering — the 50 oldest comments.
 *
 * ## Why the existing suite cannot catch this
 *
 * Every other test mocks `linearGraphQL` with a static fixture, so the mock
 * hands back the same nodes whether the query said `first:` or `last:`. A
 * static mock would pass against the bug. These tests therefore drive a FAKE
 * LINEAR API (`fakeLinearApi` below) that parses the pagination arguments out
 * of the outgoing query and applies real Relay windowing to a 60-comment
 * dataset — the ordering rules are pinned to a live probe of the real API,
 * recorded below.
 *
 * ## Live probe (api.linear.app, issue AI-2491, 4 comments), 2026-07-16
 *
 *   comments(first: 1)  => [10:21]                  <- newest
 *   comments(last:  1)  => [09:47]                  <- oldest
 *   comments(first: 3)  => [10:21, 10:16, 10:08]    <- newest N, DESCENDING
 *   comments(last:  3)  => [09:47, 10:08, 10:16]    <- oldest N, ASCENDING
 *   comments(first: 50) => [10:21, 10:16, 10:08, 09:47]
 *
 * Two facts follow, and both are load-bearing here:
 *
 *  1. `last: N` takes the OLDEST N and drops the newest. This is the bug.
 *  2. `last: N` returns them ASCENDING, so the current consumer array is
 *     already in chronological order. The defect is the WINDOW, not the order.
 *
 * Fact 2 is why AC2 below is written as a guard rather than a red test: the
 * suggested fix (`first: 50`) returns DESCENDING, so an implementer who swaps
 * the argument without reversing at the consumer will silently invert reading
 * order for every observe-issue caller. AC2 fails against that naive fix.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { linearGraphQL } from "../client";
import { getIssue } from "../issues";
import type { Comment, Issue } from "../types";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

const TOTAL_COMMENTS = 60;
const WINDOW = 50;

interface FakeComment {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string; app: boolean };
}

/**
 * 60 comments, c001 (oldest) .. c060 (newest), one per hour ascending.
 * Deliberately exceeds the 50 window so the two ends are distinguishable —
 * the repo has no such fixture today, which is why this bug shipped.
 */
const ALL_COMMENTS_CHRONOLOGICAL: FakeComment[] = Array.from(
  { length: TOTAL_COMMENTS },
  (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    const hour = String(i % 24).padStart(2, "0");
    const day = String(10 + Math.floor(i / 24)).padStart(2, "0");
    return {
      id: `c${n}`,
      body: `Comment ${n}`,
      createdAt: `2026-06-${day}T${hour}:00:00.000Z`,
      user: { name: "Ai", app: true }
    };
  }
);

const OLDEST = ALL_COMMENTS_CHRONOLOGICAL[0];
const NEWEST = ALL_COMMENTS_CHRONOLOGICAL[TOTAL_COMMENTS - 1];

/** The canonical `orderBy: createdAt` ordering as the real API returns it. */
const NEWEST_FIRST: FakeComment[] = [...ALL_COMMENTS_CHRONOLOGICAL].reverse();

/**
 * Applies the real API's windowing, per the live probe above.
 *  - `first: N` -> first N of the newest-first ordering (newest N, descending)
 *  - `last: N`  -> oldest N, ascending
 */
function applyCommentWindow(query: string): FakeComment[] {
  const first = /comments\(\s*first:\s*(\d+)/.exec(query);
  if (first) {
    return NEWEST_FIRST.slice(0, Number(first[1]));
  }

  const last = /comments\(\s*last:\s*(\d+)/.exec(query);
  if (last) {
    const n = Number(last[1]);
    return NEWEST_FIRST.slice(-n).reverse();
  }

  throw new Error(
    `AI-2494: comments connection requested with no first:/last: argument.\nQuery:\n${query}`
  );
}

/** Stands in for api.linear.app: honours the pagination args it is sent. */
function fakeLinearApi(query: string): Promise<unknown> {
  const nodes = applyCommentWindow(query);
  const issue = {
    id: "issue-uuid-2494",
    identifier: "AI-2494",
    title: "Comment window regression fixture",
    description: "",
    state: { name: "Doing", type: "started" },
    priority: 0,
    assignee: null,
    delegate: null,
    labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    children: { nodes: [] },
    projectMilestone: null,
    comments: { nodes }
  };
  return Promise.resolve({ issues: { nodes: [issue] } });
}

beforeEach(() => {
  mockedGraphQL.mockReset();
  mockedGraphQL.mockImplementation((query: string) => fakeLinearApi(query) as never);
});

/**
 * `Issue.comments` and `Comment.createdAt` are optional on the type. Assert
 * rather than coerce, so a shape regression fails loudly here instead of
 * silently degrading the window assertions below into vacuous truths.
 */
function commentsOf(issue: Issue): Comment[] {
  if (!issue.comments) {
    throw new Error("AI-2494: expected getIssue to return a comments array");
  }
  return issue.comments;
}

function createdAtOf(comment: Comment): string {
  if (!comment.createdAt) {
    throw new Error(`AI-2494: comment ${comment.id} has no createdAt`);
  }
  return comment.createdAt;
}

describe("AI-2494 AC1: the comment window contains the NEWEST comments", () => {
  it("includes the single newest comment on a >50-comment issue", async () => {
    const issue = await getIssue("AI-2494");
    const ids = commentsOf(issue).map((c) => c.id);

    // The core regression. Against `last: 50` the newest comment is absent
    // and the agent reads a stale window with no signal it was truncated.
    expect(ids).toContain(NEWEST.id);
  });

  it("drops the OLDEST comments, not the newest, when truncating to 50", async () => {
    const issue = await getIssue("AI-2494");
    const ids = commentsOf(issue).map((c) => c.id);

    expect(ids).not.toContain(OLDEST.id);
  });

  it("returns exactly the newest 50 comments (c011..c060)", async () => {
    const issue = await getIssue("AI-2494");
    const ids = commentsOf(issue).map((c) => c.id);

    const expected = ALL_COMMENTS_CHRONOLOGICAL.slice(-WINDOW).map((c) => c.id);
    expect(ids).toHaveLength(WINDOW);
    expect(ids).toEqual(expected);
  });

  it("caps the window at 50 rather than returning all 60", async () => {
    const issue = await getIssue("AI-2494");
    expect(commentsOf(issue)).toHaveLength(WINDOW);
  });
});

describe("AI-2494 AC2: comments are returned in ascending chronological order", () => {
  // GUARD, not a red test. `last: 50` already returns ascending, so this
  // passes today and must KEEP passing: it fails against a `first: 50` fix
  // that forgets to reverse at the consumer, which would invert reading order
  // for every observe-issue caller.
  it("orders the consumer array oldest-first", async () => {
    const issue = await getIssue("AI-2494");
    const times = commentsOf(issue).map((c) => Date.parse(createdAtOf(c)));

    const ascending = [...times].sort((a, b) => a - b);
    expect(times).toEqual(ascending);
  });

  it("puts the newest comment LAST in the array, not first", async () => {
    const issue = await getIssue("AI-2494");

    const comments = commentsOf(issue);
    expect(comments[comments.length - 1].id).toBe(NEWEST.id);
  });
});

describe("AI-2494 AC3: no `last:`-paginated connection under a newest-first orderBy", () => {
  const SRC_DIR = path.join(__dirname, "..");

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : sourceFiles(full);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("uses `first:` for the ISSUE_FIELDS comments connection", () => {
    const fragments = fs.readFileSync(path.join(SRC_DIR, "fragments.ts"), "utf8");

    expect(fragments).not.toMatch(/comments\(\s*last:/);
    expect(fragments).toMatch(/comments\(\s*first:\s*50/);
  });

  it("has no `last:`-paginated GraphQL connection anywhere in src/", () => {
    // Linear returns orderBy: createdAt newest-first, so `last:` on ANY
    // connection silently selects the oldest end. The established correct
    // idiom is `first:` + reverse at the consumer (boards.ts getComments).
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => /\b(last:\s*(\d+|\$\w+))/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });
});
