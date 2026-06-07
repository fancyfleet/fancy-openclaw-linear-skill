import fs from "node:fs/promises";

import { linearGraphQL } from "../client";
import { addComment, findUserByName, getIssue, updateIssue } from "../issues";
import { findStateByName } from "../states";
import { handoffIssue } from "../handoff";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

jest.mock("../issues", () => ({
  addComment: jest.fn(),
  findUserByName: jest.fn(),
  getIssue: jest.fn(),
  updateIssue: jest.fn()
}));

jest.mock("../states", () => ({
  findStateByName: jest.fn()
}));

const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockFindUserByName = findUserByName as jest.MockedFunction<typeof findUserByName>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindStateByName = findStateByName as jest.MockedFunction<typeof findStateByName>;

describe("handoffIssue", () => {
  const baseIssue = {
    id: "issue-1",
    identifier: "AI-100",
    title: "Test",
    team: { id: "team-1", key: "AI", name: "AI Systems" },
    assignee: { id: "user-matt", name: "Matt" },
    state: { id: "s-1", name: "In Progress", type: "started" }
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    mockGetIssue.mockResolvedValue(baseIssue);
    mockFindUserByName.mockResolvedValue({ id: "user-charles", name: "Charles (CTO)", app: false });
    mockFindStateByName.mockResolvedValue({ id: "state-review", name: "Needs Review" });
    mockAddComment.mockResolvedValue({ issueId: "issue-1", commentId: "comment-uuid", commentUrl: "https://linear.app/test/comment/comment-uuid", commentCreatedAt: "2026-04-26T12:00:00Z", commentBodyLength: 5, body: "Done!" });
    mockUpdateIssue.mockResolvedValue(baseIssue);
  });

  it("posts comment and updates assignee/state/delegate for human reviewer", async () => {
    mockFindUserByName.mockResolvedValue({ id: "user-charles", name: "Charles (CTO)", app: false });
    const result = await handoffIssue("AI-100", "Charles (CTO)", "All done here.");
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "All done here.");
    expect(mockUpdateIssue).toHaveBeenCalledWith("AI-100", {
      assigneeId: "user-charles",
      stateId: "state-review",
      delegateId: null
    });
    expect(result).toEqual({
      issueId: "AI-100",
      reviewer: "Charles (CTO)",
      state: "Needs Review",
      commentPosted: true,
      commentId: "comment-uuid"
    });
  });

  it("sends only delegateId (no assigneeId) when reviewer is an app user (AI-1395)", async () => {
    mockFindUserByName.mockResolvedValue({ id: "user-charles", name: "Charles (CTO)", app: true });
    const result = await handoffIssue("AI-100", "Charles (CTO)", "All done here.");
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "All done here.");
    const call = mockUpdateIssue.mock.calls[0][1] as any;
    expect(call.delegateId).toBe("user-charles");
    expect(call.stateId).toBe("state-review");
    // Linear rejects { assigneeId: app_user, delegateId: <anything> } — assigneeId must be absent
    expect(call.assigneeId).toBeUndefined();
    expect(result.reviewer).toBe("Charles (CTO)");
  });

  it("reads comment from file when --comment-file is used", async () => {
    jest.spyOn(fs, "readFile").mockResolvedValueOnce("File content here");
    const result = await handoffIssue("AI-100", "Charles (CTO)", undefined, "/path/to/file.md");
    expect(mockAddComment).toHaveBeenCalledWith("AI-100", "File content here");
    expect(result.commentPosted).toBe(true);
  });

  it("throws when body is empty", async () => {
    await expect(handoffIssue("AI-100", "Charles (CTO)", "   ")).rejects.toThrow("non-empty comment");
  });

  it("throws when reviewer is already assignee", async () => {
    mockFindUserByName.mockResolvedValue({ id: "user-matt", name: "Matt" });
    await expect(handoffIssue("AI-100", "Matt", "Handing back")).rejects.toThrow("already the assignee");
  });

  it("throws when issue has no team", async () => {
    mockGetIssue.mockResolvedValue({ ...baseIssue, team: null });
    await expect(handoffIssue("AI-100", "Charles (CTO)", "Done")).rejects.toThrow("no team");
  });

  it("throws and provides recovery info when comment fails", async () => {
    mockAddComment.mockRejectedValue(new Error("API error"));
    await expect(handoffIssue("AI-100", "Charles (CTO)", "Done")).rejects.toThrow("Handoff failed at step commentCreate");
  });

  it("throws and provides recovery info when update fails", async () => {
    mockUpdateIssue.mockRejectedValue(new Error("API error"));
    await expect(handoffIssue("AI-100", "Charles (CTO)", "Done")).rejects.toThrow("Handoff failed at step issueUpdate");
  });
});
