/**
 * AI-1562 regression suite: the skipIfStatePositionAheadOfTarget guard in
 * executeTransition must NOT use raw Linear board `position` floats to determine
 * whether a ticket is "already past" the target state.  Raw position is arbitrary
 * column-ordering; on team AI, Thinking.position = -1076 < To Do.position = 1000,
 * causing consider-work from To Do to silently no-op (false positive no-op).
 *
 * AC coverage:
 *   AC1/AC4  – consider-work from To Do proceeds when Thinking.position < To Do.position
 *   AC2      – anti-stale-revert preserved: Doing (inverted position) still no-ops
 *   AC3      – null-position ad-hoc tickets are unblocked (type rank: unstarted → started)
 *   AC5      – begin-work carries no position guard; behavior unchanged
 */

import { getSelfUser } from "../auth";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import { considerWork, beginWork } from "../semantic";
import { getComments, getIssueHistory } from "../boards";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
}));

jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  getSelfUser: jest.fn(),
}));

jest.mock("../issues", () => ({
  addComment: jest.fn(),
  findUserByName: jest.fn(),
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
  findSemanticState: jest.fn(),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn(),
}));

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockGetComments = getComments as jest.MockedFunction<typeof getComments>;
const mockGetIssueHistory = getIssueHistory as jest.MockedFunction<typeof getIssueHistory>;

const SELF = { id: "user-igor", name: "Igor (Back End Dev)", email: "igor@test.com" };

const baseIssue: any = {
  id: "issue-ai-1562",
  identifier: "AI-1562",
  title: "Repro ticket",
  team: { id: "team-ai", key: "AI", name: "AI Systems" },
  state: null,
  assignee: null,
  delegate: null,
  labels: [],
};

beforeEach(() => {
  jest.resetAllMocks();
  mockGetSelfUser.mockResolvedValue(SELF);
  mockGetComments.mockResolvedValue([]);
  mockGetIssueHistory.mockResolvedValue([]);
  mockUpdateIssue.mockImplementation(async (_id: string, _input: any) => ({
    ...baseIssue,
    state: { id: "state-thinking", name: "Thinking", type: "started", position: -1076.06 },
    delegate: SELF,
    assignee: null,
    labels: [],
  }));
});

// ---------------------------------------------------------------------------
// AC4 / AC1 — exact team-AI board ordering that triggered the original bug
// ---------------------------------------------------------------------------

describe("AC4/AC1: consider-work proceeds from To Do even when Thinking.position < To Do.position", () => {
  /**
   * Reproduces the team-AI board ordering:
   *   To Do     position =  1000
   *   Thinking  position = -1076.06
   *
   * The raw-position guard computes 1000 > -1076.06 → true → (buggy) no-op.
   * The fix must use type/stage rank instead: unstarted < started → proceed.
   */
  it("flips To Do → Thinking when Thinking.position is numerically lower than current state.position", async () => {
    const toDoState = { id: "state-todo", name: "To Do", type: "unstarted", position: 1000 };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: -1076.06 };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: toDoState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
      if (semantic === "thinking") return thinkingState;
      return toDoState;
    });

    const result = await considerWork("AI-1562");

    // Must NOT be a no-op — updateIssue must be called
    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.state).toBe("Thinking");
  });

  it("flips To Do → Thinking with the exact position values from the bug report (AI-1562)", async () => {
    // Values taken directly from the bug description
    const toDoState = { id: "state-todo", name: "To Do", type: "unstarted", position: 1000 };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: -1076.06 };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: toDoState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockResolvedValue(thinkingState);

    await considerWork("AI-1562");

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-1562",
      expect.objectContaining({ stateId: "state-thinking" }),
    );
  });

  it("returns populated context after transitioning through inverted positions", async () => {
    // When the fix is in, we must both proceed (updateIssue called) AND get context back.
    const toDoState = { id: "state-todo", name: "To Do", type: "unstarted", position: 1000 };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: -1076.06 };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: toDoState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockResolvedValue(thinkingState);

    const result = await considerWork("AI-1562");

    // Must proceed (not no-op) and return context
    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.context).toBeDefined();
    expect(result.context?.identifier).toBe("AI-1562");
  });
});

// ---------------------------------------------------------------------------
// AC2 — anti-stale-revert must still hold when positions are inverted
// ---------------------------------------------------------------------------

describe("AC2: anti-stale-revert preserved — semantically advanced states still no-op even with lower position values", () => {
  /**
   * When the board columns have been reordered so that a later-stage state
   * (Doing) has a numerically LOWER position than the target (Thinking), the raw
   * position guard produces a false NEGATIVE (allows reverting Doing → Thinking).
   * The fix must use semantic stage order to detect that Doing > Thinking.
   */
  it("no-ops when current state is Doing (semantically past Thinking) even if Doing.position < Thinking.position", async () => {
    // Inverted: Doing at position=-500 is numerically below Thinking at position=500,
    // so the current raw-position guard would NOT trigger → it incorrectly proceeds.
    const doingState = { id: "state-doing", name: "Doing", type: "started", position: -500 };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: 500 };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: doingState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
      if (semantic === "thinking") return thinkingState;
      return doingState;
    });

    const result = await considerWork("AI-1562");

    // Doing is semantically past Thinking — must no-op, not revert the state
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result.state).toBe("Doing");
    expect(result.context).toBeDefined();
  });

  it("no-ops when current state is completed type regardless of position ordering", async () => {
    // Completed tickets are handled by noopOnTerminal (separate guard), but also
    // should not be reverted by the advancement guard.
    const doneState = { id: "state-done", name: "Done", type: "completed", position: -9999 };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: 9999 };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: doneState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockResolvedValue(thinkingState);

    const result = await considerWork("AI-1562");

    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(result.state).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// AC3 — null-position ad-hoc tickets: type rank (unstarted → started) must allow the transition
// ---------------------------------------------------------------------------

describe("AC3: ad-hoc tickets with null position are unblocked by type rank", () => {
  it("considers work when both states have null position (type rank: unstarted < started)", async () => {
    const toDoState = { id: "state-todo", name: "To Do", type: "unstarted", position: null };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: null };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: toDoState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockResolvedValue(thinkingState);

    const result = await considerWork("AI-1562");

    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.state).toBe("Thinking");
  });

  it("considers work when current state has null position and target has large positive position", async () => {
    const toDoState = { id: "state-todo", name: "To Do", type: "unstarted", position: null };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: 9999 };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: toDoState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockResolvedValue(thinkingState);

    const result = await considerWork("AI-1562");

    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.state).toBe("Thinking");
  });

  it("considers work when current state has large positive position and target position is null", async () => {
    const toDoState = { id: "state-todo", name: "To Do", type: "unstarted", position: 9999 };
    const thinkingState = { id: "state-thinking", name: "Thinking", type: "started", position: null };

    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: toDoState,
      delegate: SELF,
      assignee: null,
    });
    mockFindSemanticState.mockResolvedValue(thinkingState);

    const result = await considerWork("AI-1562");

    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.state).toBe("Thinking");
  });
});

// ---------------------------------------------------------------------------
// AC5 — begin-work carries NO position guard; must be unaffected
// ---------------------------------------------------------------------------

describe("AC5: begin-work is unaffected by position ordering", () => {
  beforeEach(() => {
    // beginWork targets "doing"; wire up a mock doing state
    mockFindSemanticState.mockImplementation(async (_teamId: string, _semantic: string) => ({
      id: "state-doing",
      name: "Doing",
      type: "started",
      position: -1076.06, // same inverted position that breaks consider-work
    }));
    mockUpdateIssue.mockImplementation(async (_id: string, _input: any) => ({
      ...baseIssue,
      state: { id: "state-doing", name: "Doing", type: "started" },
      delegate: null,
      assignee: null,
    }));
  });

  it("proceeds from To Do → Doing regardless of how Doing.position compares to current state.position", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-todo", name: "To Do", type: "unstarted", position: 1000 },
      delegate: null,
      assignee: null,
    });

    const result = await beginWork("AI-1562");

    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-1562", { stateId: "state-doing" });
    expect(result.state).toBe("Doing");
  });

  it("proceeds when Doing.position is extremely negative (inverted board)", async () => {
    mockGetIssue.mockResolvedValue({
      ...baseIssue,
      state: { id: "state-todo", name: "To Do", type: "unstarted", position: 999999 },
      delegate: null,
      assignee: null,
    });

    const result = await beginWork("AI-1562");

    expect(mockUpdateIssue).toHaveBeenCalled();
    expect(result.state).toBe("Doing");
  });
});
