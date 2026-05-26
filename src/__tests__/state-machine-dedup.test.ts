import { computeWordSimilarity, findRecentDuplicate } from "../state-machine";
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
