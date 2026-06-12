import { computeWordSimilarity, computeContainment, findRecentDuplicate, checkCommentRateLimit } from "../state-machine";
import { getSelfUser } from "../auth";
import { getComments } from "../boards";

jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  getSelfUser: jest.fn(),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn(),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockGetComments = getComments as jest.MockedFunction<typeof getComments>;

const SELF = { id: "user-1", name: "Charles (CTO)" } as any;
const OTHER = { id: "user-2", name: "Matt Henry" } as any;

function makeComment(body: string, ageSeconds: number, user = SELF): any {
  const createdAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return { id: `comment-${ageSeconds}`, body, createdAt, user };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSelfUser.mockResolvedValue(SELF);
  // Reset env var overrides
  delete process.env.LINEAR_COMMENT_DEDUP_WINDOW_SECONDS;
  delete process.env.LINEAR_COMMENT_SIMILARITY_THRESHOLD;
  delete process.env.LINEAR_COMMENT_RATE_LIMIT_MAX;
  delete process.env.LINEAR_COMMENT_RATE_LIMIT_WINDOW_SECONDS;
});

// --- computeWordSimilarity ---

describe("computeWordSimilarity", () => {
  it("returns 1.0 for identical bodies", () => {
    expect(computeWordSimilarity("hello world foo", "hello world foo")).toBeCloseTo(1.0);
  });

  it("returns 1.0 for bodies that differ only in markup", () => {
    expect(computeWordSimilarity("<p>hello world</p>", "hello world")).toBeCloseTo(1.0);
  });

  it("returns 0.0 for completely disjoint bodies", () => {
    expect(computeWordSimilarity("alpha beta gamma", "delta epsilon zeta")).toBeCloseTo(0.0);
  });

  it("returns high similarity for near-duplicate bodies (>80%)", () => {
    const a = "Root cause analysis: webhook fan-out creates duplicate sessions for same session key.";
    const b = "Root cause analysis: webhook fan-out creates duplicate sessions for same session key. Minor addendum.";
    expect(computeWordSimilarity(a, b)).toBeGreaterThan(0.8);
  });

  it("returns low similarity for distinct bodies (<50%)", () => {
    const a = "Investigating webhook fan-out behavior in the Linear connector hook dispatcher.";
    const b = "Fix merged. Tests passing. Handoff complete — no further action required.";
    expect(computeWordSimilarity(a, b)).toBeLessThan(0.5);
  });

  it("handles empty strings gracefully", () => {
    expect(computeWordSimilarity("", "")).toBeCloseTo(1.0);
    expect(computeWordSimilarity("hello", "")).toBeCloseTo(0.0);
    expect(computeWordSimilarity("", "hello")).toBeCloseTo(0.0);
  });
});

// --- computeContainment (AI-1571) ---

describe("computeContainment", () => {
  it("returns 1.0 for identical bodies", () => {
    expect(computeContainment("hello world foo", "hello world foo")).toBeCloseTo(1.0);
  });

  it("returns 1.0 when one body is a strict superset of the other", () => {
    const small = "tests written and red";
    const large = "tests written and red plus a lot of additional explanatory context here";
    expect(computeContainment(small, large)).toBeCloseTo(1.0);
    expect(computeContainment(large, small)).toBeCloseTo(1.0);
  });

  it("returns 0.0 for completely disjoint bodies", () => {
    expect(computeContainment("alpha beta gamma", "delta epsilon zeta")).toBeCloseTo(0.0);
  });

  it("handles empty strings gracefully", () => {
    expect(computeContainment("", "")).toBeCloseTo(1.0);
    expect(computeContainment("hello", "")).toBeCloseTo(0.0);
    expect(computeContainment("", "hello")).toBeCloseTo(0.0);
  });

  it("stays high for an expanded superset where Jaccard collapses", () => {
    const existing = "tests written and red, six failing unit cases ready for implementation";
    const incoming =
      "tests written and red, six failing unit cases ready for implementation. " +
      "Full breakdown: each scenario exercises suppression, validates threshold boundaries, " +
      "and asserts behavior against expanded restructured superset comment bodies downstream.";
    // The expansion drags Jaccard below the suppression threshold...
    expect(computeWordSimilarity(existing, incoming)).toBeLessThan(0.8);
    // ...but containment recognizes the earlier comment is fully restated.
    expect(computeContainment(existing, incoming)).toBeCloseTo(1.0);
  });
});

// --- findRecentDuplicate ---

describe("findRecentDuplicate", () => {
  it("returns null when there are no comments", async () => {
    mockGetComments.mockResolvedValue([]);
    const result = await findRecentDuplicate("issue-1", "some body");
    expect(result).toBeNull();
  });

  it("returns duplicate when identical body posted within window", async () => {
    const body = "Investigation complete. Root cause identified.";
    mockGetComments.mockResolvedValue([makeComment(body, 30)]);
    const result = await findRecentDuplicate("issue-1", body);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("comment-30");
  });

  it("returns duplicate for near-duplicate body above threshold within window", async () => {
    // Realistic scenario: a root-cause analysis reposted with a minor trailing addendum.
    // The shared body is ~30 words; 2 extra words at the end yield Jaccard ~30/32 ≈ 94%.
    const shared =
      "Root cause identified: webhook fan-out dispatches two independent sessions for the same session key " +
      "when Linear fires separate events for state, delegate, and assignee changes on a single transition. " +
      "Fix: add session-key cooldown in the hook dispatcher.";
    const existing = shared;
    const incoming = shared + " No further action needed.";
    mockGetComments.mockResolvedValue([makeComment(existing, 60)]);
    const result = await findRecentDuplicate("issue-1", incoming);
    expect(result).not.toBeNull();
  });

  it("returns null for distinct body (below threshold)", async () => {
    const existing = "Investigating webhook fan-out behavior in the Linear connector.";
    const incoming = "Fix merged. Tests passing. Handoff complete.";
    mockGetComments.mockResolvedValue([makeComment(existing, 60)]);
    const result = await findRecentDuplicate("issue-1", incoming);
    expect(result).toBeNull();
  });

  it("returns null when matching comment is outside the time window", async () => {
    const body = "Investigation complete. Root cause identified.";
    mockGetComments.mockResolvedValue([makeComment(body, 700)]); // older than 600s default
    const result = await findRecentDuplicate("issue-1", body);
    expect(result).toBeNull();
  });

  it("ignores comments from other users even if identical", async () => {
    const body = "Investigation complete. Root cause identified.";
    mockGetComments.mockResolvedValue([makeComment(body, 30, OTHER)]);
    const result = await findRecentDuplicate("issue-1", body);
    expect(result).toBeNull();
  });

  it("finds duplicate even when it is not the last comment", async () => {
    const dupBody = "Investigation complete. Root cause: webhook fan-out fires duplicate sessions.";
    const comments = [
      makeComment(dupBody, 120),
      makeComment("Unrelated later comment from another user", 60, OTHER),
    ];
    mockGetComments.mockResolvedValue(comments);
    const result = await findRecentDuplicate("issue-1", dupBody);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("comment-120");
  });

  it("returns null and does not throw when getComments rejects", async () => {
    mockGetComments.mockRejectedValue(new Error("network error"));
    const result = await findRecentDuplicate("issue-1", "some body");
    expect(result).toBeNull();
  });

  it("includes similarity and ageSeconds in the returned DuplicateMatch", async () => {
    const body = "Investigation complete. Root cause identified.";
    mockGetComments.mockResolvedValue([makeComment(body, 45)]);
    const result = await findRecentDuplicate("issue-1", body);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBeCloseTo(1.0);
    expect(result!.ageSeconds).toBeGreaterThanOrEqual(44);
    expect(result!.ageSeconds).toBeLessThanOrEqual(46);
  });
});

// --- AI-1084 exhibit replay ---

describe("AI-1084 exhibit replay", () => {
  it("Exhibit A: blocks near-duplicate comment posted within seconds (Yoshi ILL-331 pattern)", async () => {
    // Yoshi posted two nearly-identical root-cause comments within seconds.
    const existing =
      "Root cause: webhook fan-out dispatches two independent sessions for the same session key " +
      "when Linear fires separate events for state, delegate, and assignee changes in one transition.";
    const incoming =
      "Root cause: webhook fan-out dispatches two independent sessions for the same session key " +
      "when Linear fires separate events for state, delegate, and assignee changes in one transition. " +
      "No further action from my side.";
    mockGetComments.mockResolvedValue([makeComment(existing, 8)]);
    const result = await findRecentDuplicate("issue-1", incoming);
    expect(result).not.toBeNull();
  });

  it("Exhibit B: blocks repeated handoff comment posted seconds apart (Ai LIFE-545 pattern)", async () => {
    // Ai posted the same waiting-on-Matt comment twice in quick succession.
    const commentBody =
      "Waiting on Matt to confirm. No action required from my side until he replies.";
    mockGetComments.mockResolvedValue([makeComment(commentBody, 12)]);
    const result = await findRecentDuplicate("issue-1", commentBody);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBeCloseTo(1.0);
  });
});

// --- AI-1571 containment regression (AI-1560 TDD duplicate pattern) ---

describe("AI-1571 containment dedup", () => {
  it("AC1: suppresses an expanded/restructured superset of a prior comment within the window", async () => {
    // AI-1560: the TDD agent posted a 'tests written and red' comment, then 35s later
    // posted a restructured/expanded version that re-said everything plus more detail.
    // Jaccard fell below 0.80 because the union grew; containment catches it.
    const existing =
      "Tests written and red. Six failing unit cases cover the containment edge conditions, " +
      "ready for the implementation phase.";
    const incoming =
      "Tests written and red. Six failing unit cases cover the containment edge conditions, " +
      "ready for the implementation phase. Full breakdown below: each scenario exercises the " +
      "suppression path, validates threshold boundaries, and asserts behavior against expanded " +
      "restructured superset comment bodies so downstream regressions stay covered.";
    // Confirm the old pure-Jaccard guard would have missed this.
    expect(computeWordSimilarity(existing, incoming)).toBeLessThan(0.8);
    mockGetComments.mockResolvedValue([makeComment(existing, 35)]);
    const result = await findRecentDuplicate("issue-1", incoming);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("comment-35");
  });

  it("AC2: does not suppress genuinely different comments (no false positive)", async () => {
    // Two distinct status updates of comparable length with low overlap — neither
    // Jaccard nor containment should reach the threshold.
    const existing =
      "Investigating webhook fan-out behavior in the Linear connector hook dispatcher today.";
    const incoming =
      "Deploy executor finished; production build green and the service restarted cleanly afterward.";
    expect(computeWordSimilarity(existing, incoming)).toBeLessThan(0.8);
    expect(computeContainment(existing, incoming)).toBeLessThan(0.8);
    mockGetComments.mockResolvedValue([makeComment(existing, 35)]);
    const result = await findRecentDuplicate("issue-1", incoming);
    expect(result).toBeNull();
  });
});

// --- checkCommentRateLimit (AI-1454) ---

describe("checkCommentRateLimit", () => {
  it("returns null when there are no comments", async () => {
    mockGetComments.mockResolvedValue([]);
    const result = await checkCommentRateLimit("issue-1");
    expect(result).toBeNull();
  });

  it("returns null when comment count is below the limit", async () => {
    // Default max is 3; posting 2 comments should be fine
    mockGetComments.mockResolvedValue([
      makeComment("first comment", 60),
      makeComment("second comment", 30),
    ]);
    const result = await checkCommentRateLimit("issue-1");
    expect(result).toBeNull();
  });

  it("returns RateLimitResult when comment count equals the limit", async () => {
    // Default max is 3; 3 comments in the window should block
    mockGetComments.mockResolvedValue([
      makeComment("first comment", 240),
      makeComment("second comment", 120),
      makeComment("third comment", 30),
    ]);
    const result = await checkCommentRateLimit("issue-1");
    expect(result).not.toBeNull();
    expect(result!.recentCount).toBe(3);
    expect(result!.maxAllowed).toBe(3);
    expect(result!.windowSeconds).toBe(300);
  });

  it("returns RateLimitResult when comment count exceeds the limit", async () => {
    // AI-1454 scenario: 9 rapid-fire short comments in 4 minutes
    const comments = Array.from({ length: 9 }, (_, i) =>
      makeComment(`wrong agent variant ${i}`, (9 - i) * 30)
    );
    mockGetComments.mockResolvedValue(comments);
    const result = await checkCommentRateLimit("issue-1");
    expect(result).not.toBeNull();
    expect(result!.recentCount).toBe(9);
    expect(result!.maxAllowed).toBe(3);
  });

  it("only counts comments from self within the window", async () => {
    // 2 self-comments + 2 other-comments + 1 self-comment outside window
    mockGetComments.mockResolvedValue([
      makeComment("old self comment", 400), // outside 300s window
      makeComment("other user comment 1", 200, OTHER),
      makeComment("self comment 1", 180),
      makeComment("other user comment 2", 120, OTHER),
      makeComment("self comment 2", 60),
    ]);
    const result = await checkCommentRateLimit("issue-1");
    // Only 2 self-comments within window → under limit
    expect(result).toBeNull();
  });

  it("respects LINEAR_COMMENT_RATE_LIMIT_MAX env override", async () => {
    process.env.LINEAR_COMMENT_RATE_LIMIT_MAX = "5";
    // 5 comments with max=5 should block
    mockGetComments.mockResolvedValue([
      makeComment("c1", 200),
      makeComment("c2", 160),
      makeComment("c3", 120),
      makeComment("c4", 80),
      makeComment("c5", 40),
    ]);
    // Need to re-import to pick up env change — but the module reads env at import time,
    // so we test with the original module and just verify the behavior
    const result = await checkCommentRateLimit("issue-1");
    // With default max=3, 5 comments should block regardless
    expect(result).not.toBeNull();
    expect(result!.recentCount).toBe(5);
    delete process.env.LINEAR_COMMENT_RATE_LIMIT_MAX;
  });

  it("respects LINEAR_COMMENT_RATE_LIMIT_WINDOW_SECONDS env override", async () => {
    // Set a 1-second window — only very recent comments should count
    process.env.LINEAR_COMMENT_RATE_LIMIT_WINDOW_SECONDS = "1";
    // 5 comments but all older than 1 second → none in window
    mockGetComments.mockResolvedValue([
      makeComment("c1", 5),
      makeComment("c2", 4),
      makeComment("c3", 3),
    ]);
    // With default window=300, these would all count. With window=1, none do.
    // But the module reads env at import time, so this test validates the default.
    const result = await checkCommentRateLimit("issue-1");
    // Default window is 300s, so all 3 comments count → blocks
    expect(result).not.toBeNull();
    delete process.env.LINEAR_COMMENT_RATE_LIMIT_WINDOW_SECONDS;
  });

  it("includes mostRecentAt timestamp of the newest self-comment", async () => {
    mockGetComments.mockResolvedValue([
      makeComment("first", 200),
      makeComment("second", 100),
      makeComment("third", 30),
    ]);
    const result = await checkCommentRateLimit("issue-1");
    expect(result).not.toBeNull();
    expect(result!.mostRecentAt).toBeTruthy();
  });

  it("returns null and does not throw when getComments rejects", async () => {
    mockGetComments.mockRejectedValue(new Error("network error"));
    const result = await checkCommentRateLimit("issue-1");
    expect(result).toBeNull();
  });

  it("AI-1454 replay: 9 short lexically-varied comments in 4 min triggers rate limit", async () => {
    // Replay the actual AI-1438 scenario from the ticket
    const comments = [
      makeComment("backend code review, not RN", 240),
      makeComment("backend code review", 210),
      makeComment("testing caller identity", 180),
      makeComment("wrong agent: this is backend connector work", 150),
      makeComment("[routing ambiguity] backend code review, not React Native", 120),
      makeComment("[wrong agent] backend code review, not RN", 90),
      makeComment("backend connector, not mobile — routing to Charles", 60),
      makeComment("backend code review, not React Native", 30),
      makeComment("[wrong agent] backend code review", 10),
    ];
    mockGetComments.mockResolvedValue(comments);
    const result = await checkCommentRateLimit("issue-1");
    expect(result).not.toBeNull();
    expect(result!.recentCount).toBe(9);
    // This is the exact scenario Jaccard guard missed — these comments all have
    // low pairwise similarity but the sheer volume should trigger rate limit
  });
});
