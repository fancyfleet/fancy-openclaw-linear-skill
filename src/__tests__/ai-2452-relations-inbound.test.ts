/**
 * AI-2452 (defect 1): `linear relations <id>` was structurally blind to inbound edges.
 *
 * `Issue.relations` in Linear's API only contains relations where the issue is the
 * *source*. A ticket's own blockers live in `Issue.inverseRelations`. The CLI never
 * selected that field, so `relations AI-2289` could not show "AI-2449 blocks me" —
 * and the standing fleet rule "link the blocker, then verify with `linear relations`"
 * was asking a check to confirm something it could not see.
 *
 * The repro below is the live one from the ticket: AI-2289 is blocked by AI-2449,
 * the link exists, and `relations AI-2289` returned nothing.
 */
import { ISSUE_FIELDS } from "../fragments";
import { getIssue } from "../issues";
import { listRelations, removeBlockingRelation } from "../relations";
import { linearGraphQL } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

jest.mock("../issues", () => ({
  getIssue: jest.fn(),
  updateIssue: jest.fn()
}));

const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

/** AI-2449 blocks AI-2289. Stored once, with AI-2449 as the source. */
const BLOCKER_REL = {
  id: "rel-blocker",
  type: "blocks",
  issue: { id: "u-2449", identifier: "AI-2449", title: "Blocker" },
  relatedIssue: { id: "u-2289", identifier: "AI-2289", title: "Blocked parent" }
};

/** AI-2289 blocks AI-9999. Stored once, with AI-2289 as the source. */
const OUTBOUND_REL = {
  id: "rel-outbound",
  type: "blocks",
  issue: { id: "u-2289", identifier: "AI-2289", title: "Blocked parent" },
  relatedIssue: { id: "u-9999", identifier: "AI-9999", title: "Downstream" }
};

describe("AI-2452: the query asks for inbound relations at all", () => {
  it("ISSUE_FIELDS selects inverseRelations, not just relations", () => {
    // Guard at the query layer: a perfect merge in listRelations proves nothing
    // if the fragment never fetches the inbound side.
    expect(ISSUE_FIELDS).toContain("inverseRelations");
  });

  it("selects identifiers on the inbound side so direction can be reported", () => {
    const inverseBlock = ISSUE_FIELDS.slice(ISSUE_FIELDS.indexOf("inverseRelations"));
    expect(inverseBlock).toContain("identifier");
    expect(inverseBlock).toContain("type");
  });
});

describe("AI-2452: listRelations reports inbound blockers", () => {
  beforeEach(() => mockGetIssue.mockReset());

  it("shows a blocker that only exists as an inbound edge (the AI-2289 repro)", async () => {
    mockGetIssue.mockResolvedValue({
      identifier: "AI-2289",
      relations: [],
      inverseRelations: [BLOCKER_REL]
    } as any);

    const result = await listRelations("AI-2289");

    // Before the fix this was [] — the link existed, and the verification step
    // told the agent it did not.
    expect(result).toHaveLength(1);
    // On an inbound edge the blocker is `issue`; `relatedIssue` is AI-2289 itself.
    // That asymmetry is precisely why the `relation` label below is worth having.
    expect(result[0].issue.identifier).toBe("AI-2449");
    expect(result[0].relation).toBe("blocked-by");
  });

  it("labels an inbound blocks edge as blocked-by, not blocks", async () => {
    mockGetIssue.mockResolvedValue({
      identifier: "AI-2289",
      relations: [],
      inverseRelations: [BLOCKER_REL]
    } as any);

    const [rel] = await listRelations("AI-2289");

    expect(rel.direction).toBe("inbound");
    expect(rel.relation).toBe("blocked-by");
  });

  it("labels an outbound blocks edge as blocks", async () => {
    mockGetIssue.mockResolvedValue({
      identifier: "AI-2289",
      relations: [OUTBOUND_REL],
      inverseRelations: []
    } as any);

    const [rel] = await listRelations("AI-2289");

    expect(rel.direction).toBe("outbound");
    expect(rel.relation).toBe("blocks");
  });

  it("does not conflate the two directions when both exist", async () => {
    // The trap: merging inbound into outbound under a shared `blocks` label would
    // report "AI-2289 blocks AI-2449", inverting the dependency. That is worse
    // than the omission this ticket fixes.
    mockGetIssue.mockResolvedValue({
      identifier: "AI-2289",
      relations: [OUTBOUND_REL],
      inverseRelations: [BLOCKER_REL]
    } as any);

    const result = await listRelations("AI-2289");

    expect(result).toHaveLength(2);
    const blocks = result.find((r) => r.relation === "blocks");
    const blockedBy = result.find((r) => r.relation === "blocked-by");

    expect(blocks!.relatedIssue.identifier).toBe("AI-9999");
    expect(blockedBy!.issue.identifier).toBe("AI-2449");
  });

  it("keeps symmetric `related` edges readable from either side", async () => {
    // `related` is stored once and is direction-free in meaning, so it was also
    // invisible from the target side — same root cause, quieter symptom.
    mockGetIssue.mockResolvedValue({
      identifier: "AI-2289",
      relations: [],
      inverseRelations: [
        {
          id: "rel-related",
          type: "related",
          issue: { id: "u-2082", identifier: "AI-2082", title: "Peer" },
          relatedIssue: { id: "u-2289", identifier: "AI-2289", title: "Blocked parent" }
        }
      ]
    } as any);

    const [rel] = await listRelations("AI-2289");

    expect(rel.relation).toBe("related");
    expect(rel.direction).toBe("inbound");
  });

  it("returns an empty array when the issue truly has no relations", async () => {
    mockGetIssue.mockResolvedValue({ identifier: "AI-2289", relations: [], inverseRelations: [] } as any);
    await expect(listRelations("AI-2289")).resolves.toEqual([]);
  });

  it("tolerates an API response with neither field present", async () => {
    mockGetIssue.mockResolvedValue({ identifier: "AI-2289" } as any);
    await expect(listRelations("AI-2289")).resolves.toEqual([]);
  });
});

describe("AI-2452: unblock resolves an inbound-only relation directly", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockGetIssue.mockReset();
    mockedGraphQL.mockResolvedValue({ issueRelationDelete: { success: true } });
    // Faithful per-id mock. This matters: `removeBlockingRelation` falls back to
    // looking up the *other* issue when the first lookup comes back empty, and a
    // mock that ignores the id would hide that fallback and make this test red
    // for a reason that would not hold in production.
    mockGetIssue.mockImplementation(async (id: string) =>
      (id === "AI-2289"
        ? { identifier: "AI-2289", relations: [], inverseRelations: [BLOCKER_REL] }
        : { identifier: "AI-2449", relations: [BLOCKER_REL], inverseRelations: [] }) as any
    );
  });

  it("still removes the relation", async () => {
    // Regression guard, not a defect repro: `unblock` already worked before the
    // fix, because the empty first lookup fell back to querying AI-2449.
    const result = await removeBlockingRelation("AI-2289", "AI-2449");

    expect(result.removed).toBe(true);
    expect(mockedGraphQL).toHaveBeenCalledWith(expect.stringContaining("issueRelationDelete"), { id: "rel-blocker" });
  });

  it("finds the blocker on the first lookup, without the second round-trip", async () => {
    await removeBlockingRelation("AI-2289", "AI-2449");

    // The fallback existed to work around exactly the blindness this ticket
    // fixes. With inbound edges visible, one fetch is enough.
    expect(mockGetIssue).toHaveBeenCalledTimes(1);
    expect(mockGetIssue).toHaveBeenCalledWith("AI-2289");
  });
});
