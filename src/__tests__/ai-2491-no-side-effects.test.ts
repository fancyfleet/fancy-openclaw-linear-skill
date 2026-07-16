/**
 * AI-2491 — AC 3: both commands have no side effects (no state, delegate or
 * assignee change).
 *
 * These are verification reads. An agent reaches for them precisely when it is
 * unsure what a ticket's state is — a read that mutates would corrupt the thing
 * it was asked to observe.
 */

import { linearGraphQL } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const issuesModule = require("../issues") as Record<string, unknown>;

function callOrExplain(name: string, id: string): Promise<unknown> {
  const fn = issuesModule[name];
  if (typeof fn !== "function") {
    throw new Error(
      `AI-2491 AC3: expected \`${name}\` to be exported from src/issues.ts — not implemented yet`
    );
  }
  return (fn as (arg: string) => Promise<unknown>)(id);
}

/** Mutation verbs and mutation-input fields. Read selections like `state { name type }`
 *  legitimately contain the word "state", so match on the write surface only. */
const MUTATION_MARKERS =
  /issueUpdate|issueCreate|issueDelete|commentCreate|commentUpdate|commentDelete|stateId|assigneeId|delegateId/i;

function assertEveryCallIsARead(): void {
  // Guard against a vacuous pass: a function that issues no query at all would
  // trivially satisfy "no mutations".
  expect(mockedGraphQL).toHaveBeenCalled();

  for (const call of mockedGraphQL.mock.calls) {
    const query = call[0] as string;
    expect(query).not.toMatch(/\bmutation\b/i);
    expect(query).not.toMatch(MUTATION_MARKERS);
  }
}

beforeEach(() => {
  mockedGraphQL.mockReset();
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  (process.stderr.write as jest.Mock).mockRestore();
});

describe("AI-2491: read commands have no side effects (AC 3)", () => {
  it("readState issues no mutation — nothing touching state, delegate or assignee", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: { identifier: "AI-2491", state: { name: "In Progress", type: "started" } }
    });

    await callOrExplain("readState", "AI-2491");

    assertEveryCallIsARead();
  });

  it("readLastComment issues no mutation — nothing touching state, delegate or assignee", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: {
        identifier: "AI-2491",
        comments: {
          nodes: [
            {
              id: "c-1",
              body: "A comment",
              createdAt: "2026-07-15T09:00:00Z",
              user: { name: "Ai", displayName: "Ai" }
            }
          ]
        }
      }
    });

    await callOrExplain("readLastComment", "AI-2491");

    assertEveryCallIsARead();
  });
});
