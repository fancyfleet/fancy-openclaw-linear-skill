import fs from "node:fs/promises";
import { checkMattEscalation, isMattTarget, formatRefusalError, logRefusal } from "../matt-escalation-guard";
import { handoffWork, needsHuman } from "../semantic";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { findSemanticState } from "../states";
import { getSelfUser } from "../auth";
import { resolveLabelIds } from "../labels";

jest.mock("node:fs/promises");
const mockFs = fs as jest.Mocked<typeof fs>;

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

jest.mock("../labels", () => ({
  resolveLabelIds: jest.fn(),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn(),
}));

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockFindUserByName = findUserByName as jest.MockedFunction<typeof findUserByName>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockResolveLabelIds = resolveLabelIds as jest.MockedFunction<typeof resolveLabelIds>;

const baseIssue: any = {
  id: "issue-1",
  identifier: "AI-100",
  title: "Test Issue",
  team: { id: "team-1", key: "AI", name: "AI Systems" },
  state: { id: "state-todo", name: "Todo", type: "unstarted" },
  assignee: null,
  delegate: { id: "user-hanzo", name: "Hanzo (Merge Gate)" },
};

const todoState = { id: "state-todo", name: "Todo", type: "unstarted" };

beforeEach(() => {
  jest.resetAllMocks();
  mockFs.appendFile.mockResolvedValue(undefined);
  mockFs.readFile.mockRejectedValue(new Error("not found"));
  mockGetIssue.mockResolvedValue(baseIssue);
  mockGetSelfUser.mockResolvedValue({ id: "user-hanzo", name: "Hanzo (Merge Gate)", email: "c@test.com" });
  mockFindUserByName.mockImplementation(async (name: string) => {
    const users: Record<string, { id: string; name: string }> = {
      "Matt Henry": { id: "user-matt", name: "Matt Henry" },
      "Ai": { id: "user-ai", name: "Ai" },
    };
    const user = users[name];
    if (!user) throw new Error(`Could not uniquely resolve Linear user "${name}".`);
    return user;
  });
  mockResolveUserWithHints.mockImplementation(async (name: string) => {
    const users: Record<string, { id: string; name: string; email?: string | null }> = {
      "Matt Henry": { id: "user-matt", name: "Matt Henry" },
      "Ai": { id: "user-ai", name: "Ai" },
    };
    const user = users[name];
    if (!user) throw new Error(`Could not uniquely resolve Linear user "${name}".`);
    return user;
  });
  mockFindSemanticState.mockResolvedValue(todoState);
  mockResolveLabelIds.mockResolvedValue([]);
  mockUpdateIssue.mockResolvedValue({ ...baseIssue, state: todoState });
  mockAddComment.mockResolvedValue({
    issueId: "issue-1",
    body: "comment",
    commentId: "comment-1",
    commentUrl: "https://linear.app/comment/1",
    commentCreatedAt: new Date().toISOString(),
    commentBodyLength: 10,
  });
});

// ─── Unit tests for checkMattEscalation ─────────────────────────────────────

describe("checkMattEscalation", () => {
  describe("gh-auth category", () => {
    it.each([
      ["gh auth failed, please re-authenticate", "gh auth"],
      ["The gh CLI token is expired", "gh CLI"],
      ["GitHub auth broken after rotation", "github auth"],
      ["Got a 401 from the API", "401"],
      ["Need to re-authenticate with GitHub", "re-authenticate"],
      ["Run gh auth login to fix", "gh auth login"],
    ])("refuses: %s", (text, _hint) => {
      const result = checkMattEscalation(text);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("gh-auth");
    });
  });

  describe("pr-action category", () => {
    it.each([
      ["Please open the PR for review"],
      ["Can you open this PR?"],
      ["Need you to merge the PR"],
      ["PR review is needed before deploy"],
    ])("refuses: %s", (text) => {
      const result = checkMattEscalation(text);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("pr-action");
    });
  });

  describe("ac-verification category — replaying AI-1085, AI-1086, AI-1097", () => {
    it.each([
      ["Please verify the AC before I close this"],
      ["AC verification needed — can you check?"],
      ["Need you to verify the acceptance criteria"],
      ["Please verify AC on this ticket"],
    ])("refuses: %s", (text) => {
      const result = checkMattEscalation(text);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("ac-verification");
    });
  });

  describe("prioritization category", () => {
    it.each([
      ["Should I prioritize the fix or wait?"],
      ["Which one should we ship first?"],
      ["Fix priority unclear — which of these should we do?"],
    ])("refuses: %s", (text) => {
      const result = checkMattEscalation(text);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("prioritization");
    });
  });

  describe("routing category", () => {
    it.each([
      ["Which agent should handle this?"],
      ["This is a routing question"],
      ["Who owns the deploy process?"],
    ])("refuses: %s", (text) => {
      const result = checkMattEscalation(text);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("routing");
    });
  });

  describe("credential-rotation category", () => {
    it.each([
      ["Need to refresh the token before continuing"],
      ["Please rotate credentials for the service"],
    ])("refuses: %s", (text) => {
      const result = checkMattEscalation(text);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("credential-rotation");
    });
  });

  describe("legitimate escalations — must NOT be refused", () => {
    it.each([
      ["Weekly review: what's the plan for Q3?"],
      ["Daily focus — what do you want to prioritize today?"],
      ["Matt asked me to loop you in on this decision"],
      ["External partner contacted us directly — needs your response"],
      ["You're the conversational partner for this one — forwarding the thread"],
      ["Implementation complete — ready for your review and sign-off"],
      ["The feature is shipped and live — closing the loop"],
    ])("allows: %s", (text) => {
      expect(checkMattEscalation(text)).toBeNull();
    });
  });

  it("returns null for empty string", () => {
    expect(checkMattEscalation("")).toBeNull();
  });
});

// ─── isMattTarget ───────────────────────────────────────────────────────────

describe("isMattTarget", () => {
  it.each(["Matt Henry", "matt henry", "Matt", "matt"])("matches %s", (name) => {
    expect(isMattTarget(name)).toBe(true);
  });

  it.each(["Ai", "Hanzo (Merge Gate)", "Igor (Back End Dev)", "Astrid (CPO)"])(
    "does not match %s",
    (name) => {
      expect(isMattTarget(name)).toBe(false);
    }
  );
});

// ─── formatRefusalError ─────────────────────────────────────────────────────

describe("formatRefusalError", () => {
  it("includes structured error header", () => {
    const msg = formatRefusalError("AI-100", { category: "gh-auth", matchedText: "gh auth" });
    expect(msg).toContain("MATT_ESCALATION_REFUSED: gh-auth");
    expect(msg).toContain('"gh auth"');
    expect(msg).toContain("--force-matt-escalation");
    expect(msg).toContain('linear handoff-work AI-100 "Ai"');
  });
});

// ─── logRefusal ─────────────────────────────────────────────────────────────

describe("logRefusal", () => {
  it("appends a line to the log file", async () => {
    mockFs.appendFile.mockResolvedValue(undefined);
    await logRefusal("AI-100", { category: "gh-auth", matchedText: "gh auth" }, false);
    expect(mockFs.appendFile).toHaveBeenCalledTimes(1);
    const [, content] = mockFs.appendFile.mock.calls[0] as [string, string];
    expect(content).toContain("AI-100");
    expect(content).toContain("gh-auth");
    expect(content).toContain("REFUSED");
  });

  it("marks force-bypass in log", async () => {
    mockFs.appendFile.mockResolvedValue(undefined);
    await logRefusal("AI-100", { category: "gh-auth", matchedText: "gh auth" }, true);
    const [, content] = mockFs.appendFile.mock.calls[0] as [string, string];
    expect(content).toContain("FORCE-BYPASS");
  });

  it("does not throw if log file write fails", async () => {
    mockFs.appendFile.mockRejectedValue(new Error("disk full"));
    await expect(logRefusal("AI-100", { category: "gh-auth", matchedText: "x" }, false)).resolves.toBeUndefined();
  });
});

// ─── Integration: needsHuman guard ──────────────────────────────────────────

describe("needsHuman guard", () => {
  it("refuses Matt escalation for AC verification (AI-1085 replay)", async () => {
    await expect(
      needsHuman("AI-1085", "Matt Henry", {
        comment: "Please verify the AC — the feature is deployed and needs sign-off.",
      })
    ).rejects.toThrow("MATT_ESCALATION_REFUSED: ac-verification");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("refuses Matt escalation for gh auth (AI-1086 replay)", async () => {
    await expect(
      needsHuman("AI-1086", "Matt Henry", {
        comment: "gh auth is broken — need you to re-authenticate the CLI.",
      })
    ).rejects.toThrow("MATT_ESCALATION_REFUSED: gh-auth");
  });

  it("refuses Matt escalation for PR review (AI-1097 replay)", async () => {
    await expect(
      needsHuman("AI-1097", "Matt Henry", {
        comment: "PR review needed before this can merge.",
      })
    ).rejects.toThrow("MATT_ESCALATION_REFUSED: pr-action");
  });

  it("logs the refusal", async () => {
    mockFs.appendFile.mockResolvedValue(undefined);
    await expect(
      needsHuman("AI-1085", "Matt Henry", {
        comment: "Please verify the AC.",
      })
    ).rejects.toThrow();
    expect(mockFs.appendFile).toHaveBeenCalledTimes(1);
    const [, content] = mockFs.appendFile.mock.calls[0] as [string, string];
    expect(content).toContain("REFUSED");
  });

  it("allows Matt escalation with --force-matt-escalation", async () => {
    await expect(
      needsHuman("AI-1085", "Matt Henry", {
        comment: "Please verify the AC.",
        forceMattEscalation: true,
      })
    ).resolves.toBeDefined();
    expect(mockFs.appendFile).toHaveBeenCalledTimes(1);
    const [, content] = mockFs.appendFile.mock.calls[0] as [string, string];
    expect(content).toContain("FORCE-BYPASS");
  });

  it("allows legitimate Matt escalation (no forbidden pattern)", async () => {
    await expect(
      needsHuman("AI-200", "Matt Henry", {
        comment: "External partner is waiting for your direct response — looping you in.",
      })
    ).resolves.toBeDefined();
    expect(mockUpdateIssue).toHaveBeenCalled();
  });

  it("does not apply guard for non-Matt targets", async () => {
    await expect(
      needsHuman("AI-200", "Ai", {
        comment: "gh auth is broken — Ai please handle re-authentication.",
      })
    ).resolves.toBeDefined();
    expect(mockUpdateIssue).toHaveBeenCalled();
  });
});

// ─── Integration: handoffWork guard ─────────────────────────────────────────

describe("handoffWork guard", () => {
  it("refuses handoff to Matt for PR action", async () => {
    await expect(
      handoffWork("AI-100", "Matt Henry", {
        comment: "Open this PR for review please.",
      })
    ).rejects.toThrow("MATT_ESCALATION_REFUSED: pr-action");
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("allows handoff to Matt with --force-matt-escalation", async () => {
    await expect(
      handoffWork("AI-100", "Matt Henry", {
        comment: "Open this PR for review please.",
        forceMattEscalation: true,
      })
    ).resolves.toBeDefined();
  });

  it("allows handoff to non-Matt even with forbidden patterns", async () => {
    mockFindUserByName.mockResolvedValue({ id: "user-hanzo", name: "Hanzo (Merge Gate)" });
    mockResolveUserWithHints.mockResolvedValue({ id: "user-hanzo", name: "Hanzo (Merge Gate)" });
    await expect(
      handoffWork("AI-100", "Hanzo (Merge Gate)", {
        comment: "gh auth is broken — please investigate.",
      })
    ).resolves.toBeDefined();
  });
});

// ─── LINEAR_MATT_REFUSAL_PATTERNS env var ───────────────────────────────────

describe("LINEAR_MATT_REFUSAL_PATTERNS", () => {
  const original = process.env.LINEAR_MATT_REFUSAL_PATTERNS;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.LINEAR_MATT_REFUSAL_PATTERNS;
    } else {
      process.env.LINEAR_MATT_REFUSAL_PATTERNS = original;
    }
  });

  it("adds custom patterns from env var", () => {
    process.env.LINEAR_MATT_REFUSAL_PATTERNS = JSON.stringify([
      { category: "custom-block", patterns: ["CUSTOM_BLOCK_SIGNAL"] },
    ]);
    const result = checkMattEscalation("This message contains CUSTOM_BLOCK_SIGNAL");
    expect(result?.category).toBe("custom-block");
  });

  it("ignores invalid JSON in env var without crashing", () => {
    process.env.LINEAR_MATT_REFUSAL_PATTERNS = "not-json";
    expect(() => checkMattEscalation("any text")).not.toThrow();
  });
});
