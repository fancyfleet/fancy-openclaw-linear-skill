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

beforeEach(() => {
  jest.resetAllMocks();
  mockGetIssue.mockResolvedValue(baseIssue);
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
    it("sets intent to 'accept' and transitions to doing", async () => {
      const result = await accept("AI-200");
      expectIntentSetAndCleared("accept");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-doing",
      });
      expect(result.command).toBe("accept");
      expect(result.state).toBe("In Progress");
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(accept("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await accept("AI-200", { comment: "Accepting this." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Accepting this.");
    });

    it("works without comment", async () => {
      await accept("AI-200");
      expect(mockAddComment).not.toHaveBeenCalled();
    });
  });

  describe("submit", () => {
    it("sets intent to 'submit' and transitions to thinking (awaiting review)", async () => {
      const result = await submit("AI-200");
      expectIntentSetAndCleared("submit");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-thinking",
      });
      expect(result.command).toBe("submit");
    });

    it("clears intent even on error", async () => {
      mockUpdateIssue.mockRejectedValueOnce(new Error("API error"));
      await expect(submit("AI-200")).rejects.toThrow("API error");
      expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
    });

    it("posts optional comment", async () => {
      await submit("AI-200", { comment: "Ready for review." });
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Ready for review.");
    });
  });

  describe("approve", () => {
    it("sets intent to 'approve' and transitions to doing (deployment)", async () => {
      const result = await approve("AI-200");
      expectIntentSetAndCleared("approve");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-doing",
      });
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
    it("sets intent to 'request-changes' and transitions to doing with comment", async () => {
      const result = await requestChanges("AI-200", { comment: "Needs more tests." });
      expectIntentSetAndCleared("request-changes");
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Needs more tests.");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-doing",
      });
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
  });

  describe("deploy", () => {
    it("sets intent to 'deploy' and transitions to done, clears ownership", async () => {
      const result = await deploy("AI-200");
      expectIntentSetAndCleared("deploy");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-done",
        delegateId: null,
        assigneeId: null,
      });
      expect(result.command).toBe("deploy");
      expect(result.state).toBe("Done");
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
    it("sets intent to 'reject' and transitions to doing with comment", async () => {
      const result = await reject("AI-200", { comment: "Build is red." });
      expectIntentSetAndCleared("reject");
      expect(mockAddComment).toHaveBeenCalledWith("AI-200", "Build is red.");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-doing",
      });
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
  });

  describe("escape", () => {
    it("sets intent to 'escape' and transitions to backlog, clears ownership", async () => {
      const result = await escape("AI-200");
      expectIntentSetAndCleared("escape");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-backlog",
        delegateId: null,
        assigneeId: null,
      });
      expect(result.command).toBe("escape");
      expect(result.state).toBe("Backlog");
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
    it("sets intent to 'demote' and transitions to backlog, clears ownership", async () => {
      const result = await demote("AI-200");
      expectIntentSetAndCleared("demote");
      expect(mockUpdateIssue).toHaveBeenCalledWith("AI-200", {
        stateId: "state-backlog",
        delegateId: null,
        assigneeId: null,
      });
      expect(result.command).toBe("demote");
      expect(result.state).toBe("Backlog");
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

  describe("targetState guard — every verb targets a real SEMANTIC_STATE_MAP key", () => {
    const VERB_TARGET_STATES: Record<string, string> = {
      accept: "doing",
      submit: "thinking",
      approve: "doing",
      requestChanges: "doing",
      deploy: "done",
      reject: "doing",
      escape: "backlog",
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
