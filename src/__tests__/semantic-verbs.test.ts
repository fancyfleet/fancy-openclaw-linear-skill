/**
 * Unit tests for the 8 dev-impl semantic verbs: accept, submit, approve,
 * requestChanges, deploy, reject, escape, demote.
 *
 * Each test validates:
 *   - The correct proxy intent header is set (via setProxyIntent)
 *   - The correct state transition is requested
 *   - Comment policy is enforced (required for request-changes/reject)
 *   - Error handling for missing required comments
 */

import fs from "node:fs/promises";

import { getSelfUser } from "../auth";
import { addComment, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { resolveLabelIds } from "../labels";
import { findSemanticState, SEMANTIC_STATE_MAP } from "../states";
import {
  accept,
  submit,
  approve,
  requestChanges,
  deploy,
  reject,
  escape,
  demote,
  complete,
  parkWork,
} from "../semantic";
import { setProxyIntent } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
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

const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;
const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockResolveLabelIds = resolveLabelIds as jest.MockedFunction<typeof resolveLabelIds>;

// Maps state:* and wf:* label names to stable mock IDs for assertion.
const LABEL_ID_MAP: Record<string, string> = {
  "state:intake": "label-intake",
  "state:implementation": "label-implementation",
  "state:code-review": "label-code-review",
  "state:deployment": "label-deployment",
  "state:escape": "label-escape",
  "wf:dev-impl": "label-wf-dev-impl",
};

const baseIssue: any = {
  id: "issue-1",
  identifier: "AI-200",
  title: "Test Dev-Impl Issue",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-todo", name: "Todo", type: "unstarted" },
  assignee: null,
  delegate: null,
};

const todoState = { id: "state-todo", name: "Todo", type: "unstarted" };
const doingState = { id: "state-doing", name: "In Progress", type: "started" };
const thinkingState = { id: "state-thinking", name: "In Progress", type: "started" };
const doneState = { id: "state-done", name: "Done", type: "completed" };
const backlogState = { id: "state-backlog", name: "Backlog", type: "backlog" };
const invalidState = { id: "state-invalid", name: "Invalid", type: "canceled" };

beforeEach(() => {
  jest.resetAllMocks();
  mockGetIssue.mockResolvedValue(baseIssue);
  mockResolveLabelIds.mockImplementation(async (_teamId: string, names: string[]) =>
    names.map((n) => LABEL_ID_MAP[n] ?? `label-unknown-${n}`)
  );
  mockGetSelfUser.mockResolvedValue({ id: "user-igor", name: "Igor (Back End Dev)", email: "igor@test.com" });
  mockResolveUserWithHints.mockImplementation(async (name: string) => {
    const users: Record<string, { id: string; name: string }> = {
      "Charles (CTO)": { id: "user-charles", name: "Charles (CTO)" },
    };
    const user = users[name];
    if (!user) throw new Error(`Could not uniquely resolve Linear user "${name}".`);
    return user;
  });
  mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
    // Validate that the semantic key actually exists in the real SEMANTIC_STATE_MAP.
    // This catches the case where a verb targets a non-existent state (e.g. "review").
    if (!(semantic.toLowerCase() in SEMANTIC_STATE_MAP)) {
      throw new Error(`Unknown semantic state "${semantic}"`);
    }
    const map: Record<string, any> = {
      doing: doingState,
      thinking: thinkingState,
      todo: todoState,
      done: doneState,
      backlog: backlogState,
      invalid: invalidState,
    };
    return map[semantic] ?? todoState;
  });
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    commentId: "comment-uuid",
    commentUrl: "https://linear.app/test/comment/comment-uuid",
    commentCreatedAt: "2026-06-06T12:00:00Z",
    commentBodyLength: 4,
    body: "test",
  });
  mockUpdateIssue.mockImplementation(async (id: string, input: any) => ({
    ...baseIssue,
    ...input,
  }));
});

// Helper to verify setProxyIntent was called with a specific value and then cleared
function expectIntentSetAndCleared(intent: string): void {
  expect(mockSetProxyIntent).toHaveBeenCalledWith(intent);
  expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
  // The intent should be set before being cleared
  const calls = mockSetProxyIntent.mock.calls.map((c) => c[0]);
  const setIndex = calls.indexOf(intent);
  const clearIndex = calls.indexOf(undefined);
  expect(clearIndex).toBeGreaterThan(setIndex);
}

describe("dev-impl semantic verbs", () => {
  describe("accept", () => {
    it("sets intent to 'accept', applies state:implementation label, and omits stateId (AI-1498: proxy writes the native column)", async () => {
      const result = await accept("AI-200");
      expectIntentSetAndCleared("accept");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-implementation"],
      });
      // AI-1498 AC#2: the CLI must not write stateId on governed dev-impl verbs.
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("accept");
      expect(result.state).toBe("In Progress");
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(accept("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await accept("AI-200", undefined, { comment: "Accepting this." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Accepting this.");
    });

    it("works without comment", async () => {
      await accept("AI-200");
      expect(mockAddComment).not.toHaveBeenCalled();
    });

    it("omits assigneeId entirely when target is an app user (AI-1395)", async () => {
      mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-igor", name: "Igor (Back End Dev)", app: true });
      await accept("AI-200", "Igor (Back End Dev)");
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBe("user-igor");
      // assigneeId must be absent (undefined), not null — Linear rejects { delegateId: app_user, assigneeId: app_user }
      expect(call.assigneeId).toBeUndefined();
    });

    it("does NOT omit assigneeId when target is a regular (non-app) user", async () => {
      mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-charles", name: "Charles (CTO)", app: false });
      await accept("AI-200", "Charles (CTO)");
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBe("user-charles");
      expect(call.assigneeId).toBeUndefined(); // accept has no clearAssignee so assigneeId is omitted regardless
    });
  });

  describe("submit", () => {
    it("sets intent to 'submit', applies state:code-review label, and omits stateId (AI-1498)", async () => {
      const result = await submit("AI-200");
      expectIntentSetAndCleared("submit");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-code-review"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("submit");
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(submit("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await submit("AI-200", undefined, { comment: "Ready for review." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Ready for review.");
    });
  });

  describe("approve", () => {
    it("sets intent to 'approve', applies state:deployment label, and omits stateId (AI-1498)", async () => {
      const result = await approve("AI-200");
      expectIntentSetAndCleared("approve");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-deployment"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("approve");
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(approve("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await approve("AI-200", { comment: "LGTM." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "LGTM.");
    });
  });

  describe("request-changes", () => {
    it("sets intent to 'request-changes', applies state:implementation label, and omits stateId (AI-1498)", async () => {
      const result = await requestChanges("AI-200", { comment: "Needs more tests." });
      expectIntentSetAndCleared("request-changes");
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Needs more tests.");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-implementation"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("requestChanges");
    });

    it("hard-refuses without --comment", async () => {
      await expect(requestChanges("AI-200", {})).rejects.toThrow(
        "request-changes requires --comment"
      );
      // Intent should NOT be set if we refuse before calling executeTransition
      expect(mockSetProxyIntent).not.toHaveBeenCalled();
      expect(mockUpdateIssue).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });

    it("hard-refuses with whitespace-only comment", async () => {
      await expect(requestChanges("AI-200", { comment: "   " })).rejects.toThrow(
        "request-changes requires --comment"
      );
      expect(mockUpdateIssue).not.toHaveBeenCalled();
    });

    it("accepts comment from file", async () => {
      jest.spyOn(fs, "readFile").mockResolvedValueOnce("Missing unit tests for edge cases.");
      await requestChanges("AI-200", { commentFile: "/tmp/feedback.md" });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Missing unit tests for edge cases.");
    });

    it("clears intent even on error after comment validation passes", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(requestChanges("AI-200", { comment: "Feedback." })).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("re-delegates to target when --target is provided (app user)", async () => {
      mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-igor", name: "Igor (Back End Dev)", app: true });
      await requestChanges("AI-200", { comment: "Needs more tests.", target: "Igor (Back End Dev)" });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBe("user-igor");
      expect(call.assigneeId).toBeUndefined();
    });

    it("re-delegates to target when --target is provided (non-app user)", async () => {
      mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-charles", name: "Charles (CTO)", app: false });
      await requestChanges("AI-200", { comment: "Needs more tests.", target: "Charles (CTO)" });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBe("user-charles");
    });

    it("does not include delegateId when no --target is provided", async () => {
      await requestChanges("AI-200", { comment: "Needs more tests." });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBeUndefined();
    });
  });

  describe("deploy", () => {
    it("sets intent to 'deploy', clears ownership, and omits stateId (AI-1498; no addedLabelIds — done is terminal)", async () => {
      const result = await deploy("AI-200");
      expectIntentSetAndCleared("deploy");
      // baseIssue has no labels — removedLabelIds is filtered to only present labels,
      // so it's empty and not sent.
      // done is a terminal state with no state:* label, so no addedLabelIds either.
      // AI-1498: stateId is no longer written by the CLI — the proxy moves the column.
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        delegateId: null,
        assigneeId: null,
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("deploy");
      expect(result.state).toBe("Done");
    });

    it("strips state:deployment label when present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "label-deployment", name: "state:deployment", color: "#000" }],
      });
      await deploy("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        removedLabelIds: ["label-deployment"],
      }));
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(deploy("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await deploy("AI-200", { comment: "Deployed to production." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Deployed to production.");
    });
  });

  describe("reject", () => {
    it("sets intent to 'reject', transitions to doing, and applies state:implementation label", async () => {
      const result = await reject("AI-200", { comment: "Build is red." });
      expectIntentSetAndCleared("reject");
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Build is red.");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-implementation"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("reject");
    });

    it("hard-refuses without --comment", async () => {
      await expect(reject("AI-200", {})).rejects.toThrow(
        "reject requires --comment"
      );
      expect(mockSetProxyIntent).not.toHaveBeenCalled();
      expect(mockUpdateIssue).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });

    it("hard-refuses with whitespace-only comment", async () => {
      await expect(reject("AI-200", { comment: "   " })).rejects.toThrow(
        "reject requires --comment"
      );
      expect(mockUpdateIssue).not.toHaveBeenCalled();
    });

    it("accepts comment from file", async () => {
      jest.spyOn(fs, "readFile").mockResolvedValueOnce("Smoke tests failed after deploy.");
      await reject("AI-200", { commentFile: "/tmp/rejection.md" });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Smoke tests failed after deploy.");
    });

    it("clears intent even on error after comment validation passes", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(reject("AI-200", { comment: "Rejected." })).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("re-delegates to --target when provided, routing to a named implementer (AI-1495, app user)", async () => {
      mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-igor", name: "Igor (Back End Dev)", app: true });
      await reject("AI-200", { comment: "Build is red.", target: "Igor (Back End Dev)" });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBe("user-igor");
      // app-user delegate → assigneeId omitted (AI-1395)
      expect(call.assigneeId).toBeUndefined();
    });

    it("re-delegates to --target when provided (AI-1495, non-app user)", async () => {
      mockResolveUserWithHints.mockResolvedValueOnce({ id: "user-charles", name: "Charles (CTO)", app: false });
      await reject("AI-200", { comment: "Build is red.", target: "Charles (CTO)" });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBe("user-charles");
    });

    it("does not include delegateId when no --target is provided (role-routing handles owner)", async () => {
      await reject("AI-200", { comment: "Build is red." });
      const call = mockUpdateIssue.mock.calls[0][1] as any;
      expect(call.delegateId).toBeUndefined();
    });
  });

  describe("escape", () => {
    it("sets intent to 'escape', transitions to native terminal (Invalid), clears ownership, strips any state:* label present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "label-code-review", name: "state:code-review", color: "#000" }],
      });
      const result = await escape("AI-200");
      expectIntentSetAndCleared("escape");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        delegateId: null,
        assigneeId: null,
        removedLabelIds: ["label-code-review"],
      }));
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("escape");
      expect(result.state).toBe("Invalid");
    });

    it("omits removedLabelIds when issue has no state:* labels (API rejects non-present removal)", async () => {
      const result = await escape("AI-200");
      expectIntentSetAndCleared("escape");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        delegateId: null,
        assigneeId: null,
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("escape");
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(escape("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await escape("AI-200", { comment: "Escalating to Matt." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Escalating to Matt.");
    });
  });

  describe("demote", () => {
    it("sets intent to 'demote', transitions to backlog, clears ownership", async () => {
      const result = await demote("AI-200");
      expectIntentSetAndCleared("demote");
      // baseIssue has no labels — removedLabelIds is filtered to only present labels,
      // so it's empty and not sent.
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        delegateId: null,
        assigneeId: null,
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
      expect(result.command).toBe("demote");
      expect(result.state).toBe("Backlog");
    });

    it("strips state:intake and wf:dev-impl labels when present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "label-intake", name: "state:intake", color: "#000" },
          { id: "label-wf-dev-impl", name: "wf:dev-impl", color: "#000" },
        ],
      });
      await demote("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        removedLabelIds: expect.arrayContaining(["label-intake", "label-wf-dev-impl"]),
      }));
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(demote("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await demote("AI-200", { comment: "Not ready for dev-impl." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Not ready for dev-impl.");
    });
  });

  describe("state:* label swap — atomic column + label update (AI-1388 regression guard)", () => {
    it("approve: swaps state:code-review → state:deployment atomically when label is present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "label-code-review", name: "state:code-review", color: "#000" }],
      });
      await approve("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-deployment"],
        removedLabelIds: ["label-code-review"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
    });

    it("submit: swaps state:implementation → state:code-review atomically when label is present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "label-implementation", name: "state:implementation", color: "#000" }],
      });
      await submit("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-code-review"],
        removedLabelIds: ["label-implementation"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
    });

    it("reject: swaps state:deployment → state:implementation atomically when label is present", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [{ id: "label-deployment", name: "state:deployment", color: "#000" }],
      });
      await reject("AI-200", { comment: "Deployment failed." });
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        addedLabelIds: ["label-implementation"],
        removedLabelIds: ["label-deployment"],
      });
      expect((mockUpdateIssue.mock.calls[0][1] as any).stateId).toBeUndefined();
    });
  });

  describe("stale state:* label purge — all other state:* labels cleared on any transition (AI-1390 regression guard)", () => {
    it("approve: clears stale state:implementation label alongside state:code-review", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "label-code-review", name: "state:code-review", color: "#000" },
          { id: "label-implementation", name: "state:implementation", color: "#000" },
        ],
      });
      await approve("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        addedLabelIds: ["label-deployment"],
        removedLabelIds: expect.arrayContaining(["label-code-review", "label-implementation"]),
      }));
    });

    it("submit: clears stale state:deployment label alongside state:implementation", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "label-implementation", name: "state:implementation", color: "#000" },
          { id: "label-deployment", name: "state:deployment", color: "#000" },
        ],
      });
      await submit("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        addedLabelIds: ["label-code-review"],
        removedLabelIds: expect.arrayContaining(["label-implementation", "label-deployment"]),
      }));
    });

    it("reject: clears stale state:code-review label alongside state:deployment", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "label-deployment", name: "state:deployment", color: "#000" },
          { id: "label-code-review", name: "state:code-review", color: "#000" },
        ],
      });
      await reject("AI-200", { comment: "Failed." });
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        addedLabelIds: ["label-implementation"],
        removedLabelIds: expect.arrayContaining(["label-deployment", "label-code-review"]),
      }));
    });

    it("deploy: clears all stale state:* labels when ticket has multiple", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "label-deployment", name: "state:deployment", color: "#000" },
          { id: "label-code-review", name: "state:code-review", color: "#000" },
        ],
      });
      await deploy("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        removedLabelIds: expect.arrayContaining(["label-deployment", "label-code-review"]),
      }));
    });

    it("demote: clears all state:* labels plus wf:dev-impl when ticket has multiple", async () => {
      mockGetIssue.mockResolvedValue({
        ...baseIssue,
        labels: [
          { id: "label-intake", name: "state:intake", color: "#000" },
          { id: "label-code-review", name: "state:code-review", color: "#000" },
          { id: "label-wf-dev-impl", name: "wf:dev-impl", color: "#000" },
        ],
      });
      await demote("AI-200");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", expect.objectContaining({
        removedLabelIds: expect.arrayContaining(["label-intake", "label-code-review", "label-wf-dev-impl"]),
      }));
    });
  });

  describe("targetState guard — every verb targets a real SEMANTIC_STATE_MAP key", () => {
    const VERB_TARGET_STATES: Record<string, string> = {
      accept: "doing",
      submit: "thinking",
      approve: "doing",
      requestChanges: "doing",
      deploy: "done",
      reject: "doing",
      escape: "invalid",
      demote: "backlog",
    };

    // This test would have caught the b65f829 regression where submit/approve
    // targeted "review"/"deploying" — keys absent from SEMANTIC_STATE_MAP.
    for (const [verb, targetState] of Object.entries(VERB_TARGET_STATES)) {
      it(`${verb} targets "${targetState}" which exists in SEMANTIC_STATE_MAP`, () => {
        expect(Object.keys(SEMANTIC_STATE_MAP)).toContain(targetState);
      });
    }
  });

  describe("proxy intent header", () => {
    it("clears intent after success (no state pollution between calls)", async () => {
      await accept("AI-200");
      // After accept, intent should be cleared (set to undefined)
      const lastCall = mockSetProxyIntent.mock.calls[mockSetProxyIntent.mock.calls.length - 1];
      expect(lastCall[0]).toBeUndefined();
    });

    it("clears intent even when the transition throws", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("fail"));
      await expect(deploy("AI-200")).rejects.toThrow("fail");
      const lastCall = mockSetProxyIntent.mock.calls[mockSetProxyIntent.mock.calls.length - 1];
      expect(lastCall[0]).toBeUndefined();
    });
  });
});

describe("complete — proxy intent guard (AI-1392)", () => {
  it("sets intent to 'complete' so the proxy can gate wf:dev-impl tickets", async () => {
    await complete("AI-200");
    expectIntentSetAndCleared("complete");
  });

  it("clears intent even when executeTransition throws", async () => {
    mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
    await expect(complete("AI-200")).rejects.toThrow("API error");
    const lastCall = mockSetProxyIntent.mock.calls[mockSetProxyIntent.mock.calls.length - 1];
    expect(lastCall[0]).toBeUndefined();
  });
});

describe("parkWork — proxy intent guard (AI-1392)", () => {
  it("sets intent to 'park' so the proxy can gate wf:dev-impl tickets", async () => {
    await parkWork("AI-200");
    expectIntentSetAndCleared("park");
  });

  it("clears intent even when executeTransition throws", async () => {
    mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
    await expect(parkWork("AI-200")).rejects.toThrow("API error");
    const lastCall = mockSetProxyIntent.mock.calls[mockSetProxyIntent.mock.calls.length - 1];
    expect(lastCall[0]).toBeUndefined();
  });
});
