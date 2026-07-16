/**
 * AI-2445: `linear cancel <id> --comment <reason>` — the governed verb that reaches
 * the team's `canceled`-type state ("Invalid" on the AI team).
 *
 * The won't-do sibling of `duplicate`, added to the same PR at Astrid's call: the
 * release is the scarce resource, not the code, so a second verb here costs ten
 * lines while a second ticket costs a whole release cycle.
 *
 * Same gap as `duplicate` and the same two bad workarounds — Done counts a ticket
 * nobody worked as delivery, Backlog reads as *later* rather than *never* and gets
 * picked back up. These tests pin the ACs that make the verb worth having:
 *
 *   AC1 — the target state is resolved by `type`, never by the literal name "Invalid".
 *   AC2 — delegate and assignee are cleared, so nothing re-dispatches the ticket.
 *   AC4 — a team with no canceled-type state fails explicitly, never silently → Done.
 *
 * AC3 (dead-canonical refusal) has no analogue here: a cancellation points at no
 * canonical ticket, which is exactly why the comment is required instead.
 */

import { getIssue, updateIssue, addComment } from "../issues";
import { findStateByType } from "../states";
import { setProxyIntent } from "../client";
import { cancel } from "../semantic";

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
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockFindStateByType = findStateByType as jest.MockedFunction<typeof findStateByType>;
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;

const invalidState = { id: "state-invalid", name: "Invalid", type: "canceled" };

// UUID deliberately ≠ identifier: the two key spaces must not be collapsed by a
// fixture, or a verb that mixed them up would still pass (the AI-2357 lesson).
const doomedIssue: any = {
  id: "uuid-doomed",
  identifier: "AI-2301",
  title: "re-onboard hachi + scout",
  team: { id: "team-1", key: "AI" },
  state: { id: "state-backlog", name: "Backlog", type: "backlog" },
  assignee: { id: "user-matt", name: "Matt Henry" },
  delegate: { id: "user-igor", name: "Igor (Back End Dev)" },
};

const REASON = "Reverses a deliberate Matt decision; settled, never do this.";

beforeEach(() => {
  jest.resetAllMocks();
  mockGetIssue.mockResolvedValue(doomedIssue);
  mockFindStateByType.mockResolvedValue(invalidState);
  mockUpdateIssue.mockImplementation(async () => ({
    ...doomedIssue,
    state: invalidState,
    assignee: null,
    delegate: null,
  }) as any);
  mockAddComment.mockResolvedValue({
    commentId: "c1", commentUrl: "u", commentCreatedAt: "t", commentBodyLength: REASON.length,
  } as any);
});

describe("AC1 — target state is resolved by type, not name", () => {
  it("resolves the destination via the canceled state TYPE", async () => {
    await cancel("AI-2301", { comment: REASON });

    expect(mockFindStateByType).toHaveBeenCalledWith("team-1", "canceled");
  });

  it("writes the resolved state id, whatever the team happens to name that column", async () => {
    // "Invalid" is the AI team's label for it. A team calling the column something
    // else must still work — which is why the verb is named `cancel`, not `invalid`.
    mockFindStateByType.mockResolvedValue({ id: "state-wontdo", name: "Won't Do", type: "canceled" });

    const result = await cancel("AI-2301", { comment: REASON });

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-2301",
      expect.objectContaining({ stateId: "state-wontdo" })
    );
    expect(result.state).toBe("Won't Do");
  });

  it("sets the `cancel` proxy intent so the move is governed, not a raw write", async () => {
    await cancel("AI-2301", { comment: REASON });

    expect(mockSetProxyIntent).toHaveBeenCalledWith("cancel");
  });
});

describe("AC2 — terminal: ownership cleared so nothing re-dispatches", () => {
  it("clears delegate and assignee in the same mutation as the state change", async () => {
    const result = await cancel("AI-2301", { comment: REASON });

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-2301",
      expect.objectContaining({ stateId: "state-invalid", delegateId: null, assigneeId: null })
    );
    expect(result.delegate).toBeNull();
    expect(result.assignee).toBeNull();
  });
});

describe("AC4 — a team with no canceled-type state fails explicitly", () => {
  it("propagates the resolver error instead of falling back to another state", async () => {
    mockFindStateByType.mockRejectedValue(
      new Error('Team team-1 has no workflow state of type "canceled", so this command cannot run.')
    );

    await expect(cancel("AI-2301", { comment: REASON })).rejects.toThrow(/no workflow state of type "canceled"/);
  });

  it("does NOT silently fall back to Done", async () => {
    mockFindStateByType.mockRejectedValue(new Error('no workflow state of type "canceled"'));

    await expect(cancel("AI-2301", { comment: REASON })).rejects.toThrow();

    // The whole point of the ticket: Done counts no-work-performed as delivery.
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});

describe("a reason is mandatory", () => {
  it("refuses to cancel with no comment", async () => {
    // Unlike `duplicate`, which carries its own explanation in the canonical ticket
    // it points at, a cancellation points at nothing. With no reason recorded the
    // ticket is a dead end the next auditor has to re-litigate from scratch — the
    // loop this verb exists to end.
    await expect(cancel("AI-2301")).rejects.toThrow();

    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("posts the reason to the ticket", async () => {
    await cancel("AI-2301", { comment: REASON });

    expect(mockAddComment).toHaveBeenCalledWith("AI-2301", expect.stringContaining("settled, never do this"));
  });
});

describe("backfill — an already-closed ticket can be re-stated as Invalid", () => {
  it("moves a Done ticket to the canceled state", async () => {
    // Same requirement as `duplicate`: no-op'ing on a terminal source state would
    // make re-stating wrongly-Done tickets impossible.
    mockGetIssue.mockResolvedValue({ ...doomedIssue, state: { id: "state-done", name: "Done", type: "completed" } });

    const result = await cancel("AI-2301", { comment: REASON });

    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-2301", expect.objectContaining({ stateId: "state-invalid" }));
    expect(result.state).toBe("Invalid");
  });
});
