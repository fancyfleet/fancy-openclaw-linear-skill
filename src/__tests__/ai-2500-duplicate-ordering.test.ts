/**
 * AI-2500: `linear duplicate` ordered the state move before the relation write, so
 * Linear rejected every invocation: "Issues can only be moved to a duplicate state
 * when a duplicate issue relation exists." The verb never worked once, from the day
 * AI-2445 shipped it.
 *
 * Why AI-2445's suite went green on a verb that could not run: it mocks `../client`
 * and `../issues`, and both mocks succeed unconditionally. The ordering constraint
 * is enforced by the live Linear API and by nothing in this process, so no mocked
 * test could observe it — and none asserted the order at all. That is the gap these
 * tests close. A mocked suite cannot verify a property of the world the code talks
 * to; the best it can do is pin the order we send the writes in, which is what the
 * live API actually cares about.
 *
 *   AC1 — the relation is created BEFORE the state move, and ownership is cleared.
 *   AC3 — a team with no duplicate-type state fails cleanly and writes NOTHING,
 *         relation included.
 */

import { getIssue, updateIssue } from "../issues";
import { findStateByType } from "../states";
import { linearGraphQL } from "../client";
import { duplicate } from "../semantic";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
}));

jest.mock("../issues", () => ({
  addComment: jest.fn(),
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
  findStateByType: jest.fn(),
}));

jest.mock("../labels", () => ({ resolveLabelIds: jest.fn() }));

const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockLinearGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;
const mockFindStateByType = findStateByType as jest.MockedFunction<typeof findStateByType>;

const duplicateState = { id: "state-dupe", name: "Duplicate", type: "duplicate" };

// UUID ≠ identifier throughout: the relation mutation takes UUIDs, the refusal
// messages quote identifiers, and one shared literal would hide a mix-up.
const dupeIssue: any = {
  id: "uuid-dupe",
  identifier: "AI-2223",
  title: "Credential loop, third filing",
  team: { id: "team-1", key: "AI" },
  state: { id: "state-backlog", name: "Backlog", type: "backlog" },
  assignee: { id: "user-matt", name: "Matt Henry" },
  delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
};

const canonicalIssue: any = {
  id: "uuid-canonical",
  identifier: "AI-2438",
  title: "Credential loop, canonical",
  team: { id: "team-1", key: "AI" },
  state: { id: "state-todo", name: "To Do", type: "unstarted" },
  assignee: null,
  delegate: null,
};

function issueLookup(issues: any[]) {
  return async (ref: string) => {
    const found = issues.find((i) => i.identifier === ref || i.id === ref);
    if (!found) throw new Error(`Issue not found: ${ref}`);
    return found;
  };
}

/**
 * Records the real ordering of the two writes the Linear API constrains, in the
 * order the process actually issues them. `toHaveBeenCalled` cannot express this
 * — both calls happen either way; only their sequence is the bug.
 */
let writeLog: string[];

beforeEach(() => {
  jest.resetAllMocks();
  writeLog = [];

  mockGetIssue.mockImplementation(issueLookup([dupeIssue, canonicalIssue]));
  mockFindStateByType.mockResolvedValue(duplicateState);

  mockLinearGraphQL.mockImplementation(async (query: string) => {
    if (query.includes("issueRelationCreate")) {
      writeLog.push("relation");
      return { issueRelationCreate: { success: true } } as any;
    }
    return {} as any;
  });

  mockUpdateIssue.mockImplementation(async (_id: string, input: any) => {
    if (input?.stateId) writeLog.push("state");
    return {
      ...dupeIssue,
      state: duplicateState,
      assignee: null,
      delegate: null,
    } as any;
  });
});

describe("AC1 — the duplicate relation is created before the state move", () => {
  it("issues the relation write first, then the state write", async () => {
    await duplicate("AI-2223", "AI-2438");

    // The whole ticket in one assertion. Reversed, Linear rejects the state move
    // with "Issues can only be moved to a duplicate state when a duplicate issue
    // relation exists" and the verb can never succeed.
    expect(writeLog).toEqual(["relation", "state"]);
  });

  it("still clears delegate and assignee under the new ordering", async () => {
    // AC1 also says "then clears ownership". Reordering the writes must not drop
    // the terminal guarantee that nothing re-dispatches the ticket.
    const result = await duplicate("AI-2223", "AI-2438");

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-2223",
      expect.objectContaining({ stateId: "state-dupe", delegateId: null, assigneeId: null })
    );
    expect(result.delegate).toBeNull();
    expect(result.assignee).toBeNull();
  });

  it("reports the relation and the canonical ticket back to the caller", async () => {
    const result = await duplicate("AI-2223", "AI-2438");

    expect(result.state).toBe("Duplicate");
    expect(result.canonicalId).toBe("AI-2438");
    expect(result.relationCreated).toBe(true);
    expect(result.relationError).toBeNull();
  });
});

describe("relation failure leaves the board untouched", () => {
  it("throws instead of moving state when the relation write fails", async () => {
    mockLinearGraphQL.mockRejectedValue(new Error("relation API down"));

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/relation API down/);

    // Under the old ordering the state had already landed by this point and the
    // verb returned success with relationCreated: false. Now the relation is a
    // precondition, so a failure must abort before the move — not after it.
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(writeLog).toEqual([]);
  });

  it("surfaces a relation write that reports success: false", async () => {
    mockLinearGraphQL.mockResolvedValue({ issueRelationCreate: { success: false } } as any);

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/Failed to create duplicate relation/);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});

describe("AC3 — a team with no duplicate-type state fails cleanly, before any write", () => {
  it("does not create a relation when the duplicate state cannot be resolved", async () => {
    mockFindStateByType.mockRejectedValue(
      new Error('Team team-1 has no workflow state of type "duplicate", so this command cannot run.')
    );

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/no workflow state of type "duplicate"/);

    // The regression a naive swap introduces: resolving the state inside
    // executeTransition means the relation is already written by the time the
    // resolver throws, leaving a stray link on a board that can never complete
    // the consolidation. AI-2445's version of this test only checked updateIssue,
    // so it stayed green through exactly that bug.
    expect(mockLinearGraphQL).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(writeLog).toEqual([]);
  });
});

describe("pre-write refusals still precede the relation", () => {
  it("refuses self-duplication without writing a relation", async () => {
    await expect(duplicate("AI-2223", "AI-2223")).rejects.toThrow(/duplicate of itself/);
    expect(mockLinearGraphQL).not.toHaveBeenCalled();
  });

  it("refuses a dead canonical ticket without writing a relation", async () => {
    mockGetIssue.mockImplementation(
      issueLookup([dupeIssue, { ...canonicalIssue, state: { name: "Invalid", type: "canceled" } }])
    );

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/is itself in a dead state/);
    expect(mockLinearGraphQL).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});
