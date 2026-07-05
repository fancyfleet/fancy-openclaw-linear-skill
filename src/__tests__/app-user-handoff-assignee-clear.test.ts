/**
 * AI-1821: handoff-work to app-user delegate must clear existing assignee
 * (assignee drift, AI-1395 fallout)
 *
 * AC coverage:
 *   AC2 (regression) — agent→app-user handoff with assignee=null leaves assignee null
 *   AC3 (fix covered by test) — clearing controlled via assigneeId:null, not omitted
 *   AC4 (set→cleared) — agent→app-user handoff with existing human assignee clears it;
 *                        covers both fix sites:
 *                          • handoff.ts:40-45  (--review-handoff payload)
 *                          • state-machine.ts:612-623 (app-user guard overrides null→undefined)
 *
 * Root cause (AC1, done): The AI-1395 fix omits assigneeId entirely for app-user delegates,
 * but Linear's API accepts { delegateId: app_user, assigneeId: null }.  The guard in
 * state-machine.ts unconditionally sets assigneeId=undefined, preventing clearAssignee
 * from working.  handoff.ts never sends assigneeId:null for app-user reviewers.
 * Fix: send null, don't omit.
 */

import fs from "node:fs/promises";

// --- handoff.ts imports ---
import { handoffIssue } from "../handoff";
import { addComment, findUserByName, getIssue, updateIssue } from "../issues";
import { findStateByName } from "../states";

// --- state-machine.ts imports ---
import { executeTransition } from "../state-machine";
import { getSelfUser } from "../auth";
import { findSemanticState } from "../states";
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

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findStateByName: jest.fn(),
  findSemanticState: jest.fn(),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn().mockResolvedValue([]),
}));

jest.mock("node:fs/promises", () => ({
  ...jest.requireActual("node:fs/promises"),
  readFile: jest.fn(),
}));

const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockFindUserByName = findUserByName as jest.MockedFunction<typeof findUserByName>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindStateByName = findStateByName as jest.MockedFunction<typeof findStateByName>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;

const MATT = { id: "user-matt", name: "Matt Henry", app: false };
const HANZO = { id: "user-hanzo", name: "Hanzo (Merge Gate)", app: false };
const GROVER = { id: "user-grover", name: "Grover (OpenClaw Mechanic)", app: true };
const SELF = { id: "user-self", name: "Ai", app: true };
const TEAM = { id: "team-ai", key: "AI", name: "AI Systems" };
const REVIEW_STATE = { id: "state-review", name: "In Review" };
const THINKING_STATE = { id: "state-thinking", name: "Thinking" };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSelfUser.mockResolvedValue(SELF);
});

// =====================================================================
// handoffIssue tests (AC4 fix site 2: handoff.ts:40-45)
// =====================================================================

describe("handoffIssue — app-user delegate assignee clearing (AI-1821)", () => {
  const baseIssue = {
    id: "issue-1",
    identifier: "AI-1821",
    title: "Test ticket",
    team: TEAM,
    state: { id: "s-doing", name: "In Progress", type: "started" },
  };

  beforeEach(() => {
    mockFindStateByName.mockResolvedValue(REVIEW_STATE);
    mockAddComment.mockResolvedValue({
      issueId: "issue-1",
      commentId: "comment-uuid",
      commentUrl: "https://linear.app/test/comment/comment-uuid",
      commentCreatedAt: "2026-07-05T16:00:00Z",
      commentBodyLength: 10,
      body: "Done",
    });
    mockUpdateIssue.mockResolvedValue(baseIssue);
  });

  // AC4: handoff.ts fix site — app-user reviewer must send assigneeId:null
  it("AC4/handoff.ts: sends assigneeId:null when reviewer is app user and issue has a human assignee", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, assignee: MATT });
    mockFindUserByName.mockResolvedValue(GROVER);

    await handoffIssue("AI-1821", "Grover (OpenClaw Mechanic)", "Ready for review.");

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, any>;
    expect(payload.delegateId).toBe(GROVER.id);
    expect(payload.stateId).toBe(REVIEW_STATE.id);
    // THE FIX: must send null to clear the existing human assignee.
    // Current bug: assigneeId is omitted entirely (undefined).
    expect(payload.assigneeId).toBeNull();
  });

  // AC2: regression — null assignee must remain null (not get set to something)
  it("AC2/handoff.ts: sends assigneeId:null when reviewer is app user and issue has no assignee", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, assignee: null });
    mockFindUserByName.mockResolvedValue(GROVER);

    await handoffIssue("AI-1821", "Grover (OpenClaw Mechanic)", "Ready for review.");

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, any>;
    expect(payload.delegateId).toBe(GROVER.id);
    expect(payload.stateId).toBe(REVIEW_STATE.id);
    // Must explicitly send null (not undefined, not a user ID) so the API
    // is unambiguous. Current bug: assigneeId is omitted entirely.
    expect(payload.assigneeId).toBeNull();
  });

  // Ensure human reviewer path is unchanged (regression guard)
  it("human reviewer still sets assigneeId to reviewer ID (regression guard)", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, assignee: MATT });
    mockFindUserByName.mockResolvedValue(HANZO);

    await handoffIssue("AI-1821", "Hanzo (Merge Gate)", "Review please.");

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, any>;
    expect(payload.assigneeId).toBe(HANZO.id);
    expect(payload.delegateId).toBeNull();
  });
});

// =====================================================================
// executeTransition tests (AC4 fix site 1: state-machine.ts:612-623)
// =====================================================================

describe("executeTransition — app-user delegate + clearAssignee (AI-1821)", () => {
  const { resolveUserWithHints } = jest.requireMock("../issues");
  const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof import("../issues").resolveUserWithHints>;

  const baseIssue = {
    id: "issue-1",
    identifier: "AI-1821",
    title: "Test ticket",
    team: TEAM,
    state: { id: "s-todo", name: "To Do", type: "unstarted" },
    assignee: MATT,
    delegate: { id: "user-self", name: "Ai", app: true },
    labels: [],
  };

  beforeEach(() => {
    mockGetIssue.mockResolvedValue(baseIssue);
    mockFindSemanticState.mockResolvedValue(THINKING_STATE);
    mockAddComment.mockResolvedValue({
      issueId: "issue-1",
      commentId: "comment-uuid",
      commentUrl: "https://linear.app/test/comment/comment-uuid",
      commentCreatedAt: "2026-07-05T16:00:00Z",
      commentBodyLength: 10,
      body: "Taking this.",
    });
    // Mock updateIssue to reflect the mutation back (delegate changes, etc.)
    mockUpdateIssue.mockImplementation(async (_id: string, payload: any) => ({
      ...baseIssue,
      assignee: payload.assigneeId ? { id: payload.assigneeId, name: "test" } : null,
      delegate: payload.delegateId ? { id: payload.delegateId, name: "Grover (OpenClaw Mechanic)" } : null,
      state: payload.stateId ? { id: payload.stateId, name: "Thinking", type: "started" } : baseIssue.state,
    }));
    mockResolveUserWithHints.mockResolvedValue(GROVER);
  });

  // AC4: state-machine.ts fix site — clearAssignee must NOT be overridden to undefined
  // when delegate is an app user. The guard at state-machine.ts:612-623 currently
  // sets assigneeId=undefined unconditionally for app-user delegates, which prevents
  // clearing an existing assignee.
  it("AC4/state-machine.ts: clearAssignee sends assigneeId:null even when delegate is app user", async () => {
    const result = await executeTransition(
      "handoff-work",
      { issueId: "AI-1821", comment: "Handing to Grover." },
      {
        targetState: "thinking",
        commentMode: "optional",
        delegateName: "Grover (OpenClaw Mechanic)",
        clearAssignee: true,
      }
    );

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, any>;
    expect(payload.delegateId).toBe(GROVER.id);
    // THE FIX: assigneeId must be null (clear), not omitted.
    // Current bug: AI-1395 guard overrides assigneeId=null → undefined, so it's absent.
    expect(payload.assigneeId).toBeNull();
  });

  // AC2/AC3: regression — when no explicit assignee change is requested and the
  // issue already has no assignee, the payload should not carry a specific assigneeId.
  // This verifies the fix doesn't break the no-change path.
  it("AC2/state-machine.ts: no assignee change when issue already has no assignee sends no assigneeId", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, assignee: null });

    const result = await executeTransition(
      "consider-work",
      { issueId: "AI-1821", comment: "Looking at this." },
      {
        targetState: "thinking",
        commentMode: "optional",
        delegateToSelf: true,
        skipIfStatePositionAheadOfTarget: true,
        requireSelfDelegated: true,
      }
    );

    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, any>;
    // No assignee change requested → assigneeId should not be in payload.
    // (undefined is intentionally omitted from the payload.)
    expect(payload.assigneeId).toBeUndefined();
  });

  // AC3: verifies that the fix is a single-mutation solution (assigneeId:null in
  // the primary mutation). The test passes only when the implementation sends
  // assigneeId:null rather than requiring a follow-up mutation.
  it("AC3: clearing is achieved in a single mutation (no follow-up needed)", async () => {
    mockUpdateIssue.mockResolvedValue({ ...baseIssue, assignee: null, delegate: GROVER });

    await executeTransition(
      "handoff-work",
      { issueId: "AI-1821", comment: "Handing to Grover for review." },
      {
        targetState: "review",
        commentMode: "optional",
        delegateName: "Grover (OpenClaw Mechanic)",
        clearAssignee: true,
      }
    );

    // If the fix is correct, exactly ONE mutation carries assigneeId:null.
    // A broken fix that needs a follow-up mutation would call updateIssue twice.
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1] as Record<string, any>;
    expect(payload.assigneeId).toBeNull();
    expect(payload.delegateId).toBe(GROVER.id);
  });
});
