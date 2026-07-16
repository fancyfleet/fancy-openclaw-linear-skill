/**
 * AI-2445: `linear duplicate <id> <canonical-id>` — the governed verb that reaches
 * the team's `duplicate`-type state.
 *
 * Before this verb, no governed verb could reach the duplicate state, so an agent
 * that correctly identified a duplicate had to choose between `complete` (counts
 * no-work-performed as delivery) and `park` (Backlog reads as *later*, not *never*,
 * so the duplicate gets picked back up). These tests pin the three failures that
 * made the choice matter:
 *
 *   AC1 — the target state is resolved by `type`, never by the literal name.
 *   AC2 — delegate and assignee are cleared, so nothing re-dispatches the ticket.
 *   AC3 — pointing at a dead canonical ticket is refused, before any mutation.
 *   AC4 — a team with no duplicate-type state fails explicitly, never silently → Done.
 *
 * Note on identifiers: every issue below uses a UUID that is deliberately DIFFERENT
 * from its human identifier (id "uuid-dupe" vs identifier "AI-2223"). Linear's
 * relation mutation takes UUIDs while the refusal messages quote identifiers; a
 * single shared literal would collapse both key spaces and pass even if the verb
 * mixed them up.
 */

import { getIssue, updateIssue, addComment } from "../issues";
import { findStateByType } from "../states";
import { linearGraphQL, setProxyIntent } from "../client";
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
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;

const duplicateState = { id: "state-dupe", name: "Duplicate", type: "duplicate" };

// The ticket being consolidated away. UUID ≠ identifier, deliberately.
const dupeIssue: any = {
  id: "uuid-dupe",
  identifier: "AI-2223",
  title: "Credential loop, third filing",
  team: { id: "team-1", key: "AI" },
  state: { id: "state-backlog", name: "Backlog", type: "backlog" },
  assignee: { id: "user-matt", name: "Matt Henry" },
  delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
};

// The live canonical ticket that survives consolidation.
const canonicalIssue: any = {
  id: "uuid-canonical",
  identifier: "AI-2438",
  title: "Credential loop, canonical",
  team: { id: "team-1", key: "AI" },
  state: { id: "state-todo", name: "To Do", type: "unstarted" },
  assignee: null,
  delegate: null,
};

/** Route getIssue by whichever key the caller passed (identifier or UUID). */
function issueLookup(issues: any[]) {
  return async (ref: string) => {
    const found = issues.find((i) => i.identifier === ref || i.id === ref);
    if (!found) throw new Error(`Issue not found: ${ref}`);
    return found;
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetIssue.mockImplementation(issueLookup([dupeIssue, canonicalIssue]));
  mockFindStateByType.mockResolvedValue(duplicateState);
  mockUpdateIssue.mockImplementation(async (_id: string, _input: any) => ({
    ...dupeIssue,
    state: duplicateState,
    assignee: null,
    delegate: null,
  }) as any);
  mockLinearGraphQL.mockResolvedValue({ issueRelationCreate: { success: true } } as any);
});

describe("AC1 — target state is resolved by type, not name", () => {
  it("resolves the destination via the duplicate state TYPE", async () => {
    await duplicate("AI-2223", "AI-2438");

    expect(mockFindStateByType).toHaveBeenCalledWith("team-1", "duplicate");
  });

  it("writes the resolved state id, whatever the team happens to name that column", async () => {
    // A team that calls its duplicate column something else entirely must still work:
    // resolution is by type, so the name is irrelevant to the verb.
    mockFindStateByType.mockResolvedValue({ id: "state-consolidated", name: "Merged Away", type: "duplicate" });

    const result = await duplicate("AI-2223", "AI-2438");

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-2223",
      expect.objectContaining({ stateId: "state-consolidated" })
    );
    expect(result.state).toBe("Merged Away");
  });

  it("sets the `duplicate` proxy intent so the move is governed, not a raw write", async () => {
    await duplicate("AI-2223", "AI-2438");

    expect(mockSetProxyIntent).toHaveBeenCalledWith("duplicate");
  });
});

describe("AC2 — terminal: ownership cleared so nothing re-dispatches", () => {
  it("clears delegate and assignee in the same mutation as the state change", async () => {
    const result = await duplicate("AI-2223", "AI-2438");

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-2223",
      expect.objectContaining({ stateId: "state-dupe", delegateId: null, assigneeId: null })
    );
    expect(result.delegate).toBeNull();
    expect(result.assignee).toBeNull();
  });
});

describe("AC3 — refuses a canonical ticket that is itself dead", () => {
  it.each([
    ["duplicate", { id: "state-dupe2", name: "Duplicate", type: "duplicate" }],
    ["canceled", { id: "state-invalid", name: "Invalid", type: "canceled" }],
  ])("refuses when the canonical ticket is in a %s-type state", async (_label, state) => {
    mockGetIssue.mockImplementation(issueLookup([dupeIssue, { ...canonicalIssue, state }]));

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/is itself in a dead state/);
  });

  it("makes NO mutation when the canonical is dead — a refusal leaves the board untouched", async () => {
    mockGetIssue.mockImplementation(
      issueLookup([dupeIssue, { ...canonicalIssue, state: { id: "s", name: "Invalid", type: "canceled" } }])
    );

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow();

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockLinearGraphQL).not.toHaveBeenCalled();
  });

  it("names both tickets and the offending state so the caller can find the live canonical", async () => {
    mockGetIssue.mockImplementation(
      issueLookup([dupeIssue, { ...canonicalIssue, state: { id: "s", name: "Invalid", type: "canceled" } }])
    );

    // The error must quote human identifiers, not UUIDs — it is read by an agent
    // that has to go find the surviving ticket.
    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/AI-2223/);
    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/AI-2438/);
    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/Invalid/);
  });

  it("refuses to mark a ticket a duplicate of itself", async () => {
    await expect(duplicate("AI-2223", "AI-2223")).rejects.toThrow(/duplicate of itself/);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});

describe("AC4 — a team with no duplicate-type state fails explicitly", () => {
  it("propagates the resolver error instead of falling back to another state", async () => {
    mockFindStateByType.mockRejectedValue(
      new Error('Team team-1 has no workflow state of type "duplicate", so this command cannot run.')
    );

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow(/no workflow state of type "duplicate"/);
  });

  it("does NOT silently fall back to Done", async () => {
    mockFindStateByType.mockRejectedValue(new Error('no workflow state of type "duplicate"'));

    await expect(duplicate("AI-2223", "AI-2438")).rejects.toThrow();

    // The whole point of the ticket: Done counts no-work-performed as delivery.
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});

describe("structural duplicate relation", () => {
  it("links the duplicate to the canonical by UUID, not by human identifier", async () => {
    await duplicate("AI-2223", "AI-2438");

    const [query, variables] = mockLinearGraphQL.mock.calls[0];
    expect(query).toContain("issueRelationCreate");
    expect(query).toContain("type: duplicate");
    // Linear's relation mutation takes UUIDs. Passing "AI-2223"/"AI-2438" here would
    // fail in production but pass a test whose fixtures reused one literal for both.
    expect(variables).toEqual({ issueId: "uuid-dupe", relatedIssueId: "uuid-canonical" });
  });

  it("reports the canonical identifier back to the caller", async () => {
    const result = await duplicate("AI-2223", "AI-2438");

    expect(result.canonicalId).toBe("AI-2438");
    expect(result.relationCreated).toBe(true);
    expect(result.relationError).toBeNull();
  });

  it("keeps the state change when only the relation write fails", async () => {
    // The state is the load-bearing outcome. Throwing here would present a landed
    // consolidation as failed and invite a retry that re-runs the whole verb.
    mockLinearGraphQL.mockRejectedValue(new Error("relation API down"));
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await duplicate("AI-2223", "AI-2438");

    expect(result.state).toBe("Duplicate");
    expect(result.relationCreated).toBe(false);
    expect(result.relationError).toMatch(/relation API down/);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not be created"));
    stderr.mockRestore();
  });
});

describe("backfill — an already-closed ticket can be re-stated as Duplicate", () => {
  it("moves a Done ticket to Duplicate", async () => {
    // The 7 tickets in AI-2445's backfill list are all Done and ad-hoc: they were
    // closed as duplicates with no work performed and are currently miscounted as
    // delivery. The verb must NOT no-op on a terminal source state, or the backfill
    // it exists to enable is impossible.
    const doneIssue = { ...dupeIssue, state: { id: "state-done", name: "Done", type: "completed" } };
    mockGetIssue.mockImplementation(issueLookup([doneIssue, canonicalIssue]));

    const result = await duplicate("AI-2223", "AI-2438");

    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-2223", expect.objectContaining({ stateId: "state-dupe" }));
    expect(result.state).toBe("Duplicate");
  });
});

describe("comment carriage", () => {
  it("posts the consolidation rationale when one is given", async () => {
    (addComment as jest.MockedFunction<typeof addComment>).mockResolvedValue({
      commentId: "c1", commentUrl: "u", commentCreatedAt: "t", commentBodyLength: 5,
    } as any);

    const result = await duplicate("AI-2223", "AI-2438", { comment: "dupe of AI-2438" });

    expect(addComment).toHaveBeenCalledWith("AI-2223", "dupe of AI-2438");
    expect(result.commentPosted).toBe(true);
  });

  it("does not require a comment", async () => {
    await expect(duplicate("AI-2223", "AI-2438")).resolves.toBeDefined();
  });
});
