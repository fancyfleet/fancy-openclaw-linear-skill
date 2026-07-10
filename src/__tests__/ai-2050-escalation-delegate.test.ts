/**
 * AI-2050: needs-human leaves delegate set, looping blocked tickets back into agent queues.
 *
 * AC coverage:
 *   AC1 — a delegate CLEAR that does not persist emits an explicit warning naming the
 *         still-set delegate and the `undelegate` remedy. The pre-existing write
 *         verification (state-machine.ts, AI-1769 AC3) only fires for a non-null
 *         delegateId, so `needs-human` (delegateId: null) never verified its clear:
 *         the ticket stayed delegated and re-entered the agent's heartbeat queue.
 *         Also covers `undelegate`, which reported `delegate: null` unconditionally.
 *   AC2 — `handoff-work <ID> "<human>"` fails with an actionable error naming
 *         `needs-human`, before any comment is posted, instead of surfacing the raw
 *         GraphQL `delegateId must correspond to an app user`.
 *   AC3 — MATT_ESCALATION_REFUSED cites the live `governance/escalation-rules.md`.
 */

import { needsHuman, handoffWork, undelegate } from "../semantic";
import { addComment, getIssue, updateIssue, resolveUserWithHints } from "../issues";
import { getSelfUser } from "../auth";
import { findSemanticState } from "../states";
import { formatRefusalError } from "../matt-escalation-guard";

jest.mock("../client", () => ({ ...jest.requireActual("../client"), linearGraphQL: jest.fn() }));
jest.mock("../auth", () => ({ ...jest.requireActual("../auth"), getSelfUser: jest.fn() }));
jest.mock("../issues", () => ({
  addComment: jest.fn(),
  findUserByName: jest.fn(),
  resolveUserWithHints: jest.fn(),
  getIssue: jest.fn(),
  updateIssue: jest.fn(),
}));
jest.mock("../states", () => ({ ...jest.requireActual("../states"), findSemanticState: jest.fn() }));
jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

const AI = { id: "agent-ai", name: "Ai", app: true };
const MATT = { id: "user-matt", name: "Matt Henry", app: false };
const TODO = { id: "state-todo", name: "Todo", type: "unstarted", position: 1 };

function issueWith(overrides: Record<string, unknown> = {}) {
  return {
    id: "iss-1",
    identifier: "AI-2048",
    state: TODO,
    delegate: null,
    assignee: null,
    labels: [],
    team: { id: "team-1", key: "AI" },
    ...overrides,
  };
}

let stderr: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LINEAR_PROXY_URL;
  stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  (getSelfUser as jest.Mock).mockResolvedValue(AI);
  (findSemanticState as jest.Mock).mockResolvedValue(TODO);
  (addComment as jest.Mock).mockResolvedValue({
    commentId: "c1", commentUrl: "u", commentCreatedAt: "t", commentBodyLength: 5,
  });
});

afterEach(() => stderr.mockRestore());

const stderrText = () => stderr.mock.calls.map((c) => String(c[0])).join("\n");

describe("AC1 — needs-human verifies the delegate clear actually persisted", () => {
  test("warns, naming the still-set delegate and the undelegate remedy, when the clear does not persist", async () => {
    const before = issueWith({ delegate: AI });
    (getIssue as jest.Mock).mockResolvedValue(before);
    (resolveUserWithHints as jest.Mock).mockResolvedValue(MATT);
    // Server rejected the clear: delegate survives the write.
    (updateIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI, assignee: MATT }));

    const result = await needsHuman("AI-2048", "Matt Henry", { comment: "blocked on you" });

    // The escalation itself landed, so this must not throw — but it must be loud.
    const text = stderrText();
    expect(text).toMatch(/did not clear the delegate/i);
    expect(text).toContain("Ai");
    expect(text).toContain("linear undelegate AI-2048");

    // And the result must report reality, not the intent.
    expect(result.delegate).toBe("Ai");
  });

  test("sends delegateId:null and stays silent when the clear persists", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue(MATT);
    (updateIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: null, assignee: MATT }));

    const result = await needsHuman("AI-2048", "Matt Henry", { comment: "blocked on you" });

    expect((updateIssue as jest.Mock).mock.calls[0][1]).toMatchObject({
      delegateId: null,
      assigneeId: MATT.id,
    });
    expect(stderrText()).not.toMatch(/did not clear the delegate/i);
    expect(result.delegate).toBeNull();
    expect(result.assignee).toBe("Matt Henry");
  });
});

describe("AC1 — undelegate reports the delegate it actually left behind", () => {
  test("warns and reports the surviving delegate instead of claiming null", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI, assignee: MATT }));
    (updateIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI, assignee: MATT }));

    const result = await undelegate("AI-2048");

    expect(result.delegate).toBe("Ai");
    expect(stderrText()).toMatch(/did not clear the delegate/i);
  });

  test("reports null when the clear persists", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI, assignee: MATT }));
    (updateIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: null, assignee: null }));

    const result = await undelegate("AI-2048");

    expect(result.delegate).toBeNull();
    expect(result.assignee).toBeNull();
    expect(stderrText()).not.toMatch(/did not clear the delegate/i);
  });
});

describe("AC2 — handoff-work to a human fails actionably", () => {
  // Linear's own constraint is `delegateId must correspond to an app user`, so a
  // resolved user with app === false is one the API is guaranteed to reject. The
  // pre-check therefore cannot block a legitimate delegate — it only moves the
  // failure earlier, before the comment is posted. Verified against the workspace:
  // all 29 agents are app:true; the only app:false users are the two humans.
  test("names needs-human, and posts no comment, when the delegate target is a human", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue(MATT);

    await expect(
      handoffWork("AI-2048", "Matt Henry", { comment: "please run the admin command" })
    ).rejects.toThrow(/needs-human/);

    // Fails before the mutation and before the comment — no half-applied handoff.
    // A comment posted here is precisely the spurious-comment loop AI-2050 fixes.
    expect(updateIssue).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  test("the error explains the app-user constraint and names the human", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue(MATT);

    const err: Error = await handoffWork("AI-2048", "Matt Henry", { comment: "x" }).then(
      () => { throw new Error("expected handoff-work to reject"); },
      (e: Error) => e
    );

    expect(err.message).toContain("Matt Henry");
    expect(err.message).toMatch(/app user|agent/i);
    expect(err.message).toContain('linear needs-human AI-2048 "Matt Henry"');
    expect(err.message).not.toMatch(/delegateId must correspond/i);
    // The message must name the CLI verb the agent typed, not the internal
    // camelCase transition name.
    expect(err.message).toMatch(/^handoff-work failed/);
    expect(err.message).not.toMatch(/handoffWork/);
  });

  test("an agent delegate is unaffected", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: null }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue(AI);
    (updateIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: AI }));

    const result = await handoffWork("AI-2048", "Ai", { comment: "over to you" });

    expect(result.delegate).toBe("Ai");
  });

  test("a UUID delegate (no app flag known) is not pre-emptively blocked", async () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: null }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue({ id: uuid, name: uuid });
    (updateIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: { id: uuid, name: uuid } }));

    await expect(handoffWork("AI-2048", uuid, { comment: "over to you" })).resolves.toBeDefined();
  });

  test("a raw app-user rejection from the API is translated, not leaked", async () => {
    // Defense in depth for the UUID path above, where `app` is unknown up front.
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: null }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue({ id: uuid, name: uuid });
    (updateIssue as jest.Mock).mockRejectedValue(
      new Error("delegateId must correspond to an app user")
    );

    const err: Error = await handoffWork("AI-2048", uuid, { comment: "x" }).then(
      () => { throw new Error("expected handoff-work to reject"); },
      (e: Error) => e
    );

    expect(err.message).toMatch(/needs-human/);
    expect(err.message).toMatch(/app user/i);
  });

  test("an unrelated API error is passed through unchanged", async () => {
    (getIssue as jest.Mock).mockResolvedValue(issueWith({ delegate: null }));
    (resolveUserWithHints as jest.Mock).mockResolvedValue(AI);
    (updateIssue as jest.Mock).mockRejectedValue(new Error("Linear API unreachable: ETIMEDOUT"));

    await expect(handoffWork("AI-2048", "Ai", { comment: "x" })).rejects.toThrow(/ETIMEDOUT/);
  });
});

describe("AC3 — refusal message cites a live doc path", () => {
  test("points at governance/escalation-rules.md, not the dead restructure path", () => {
    const msg = formatRefusalError("AI-2048", { category: "gh-auth", matchedText: "gh auth" });

    expect(msg).toContain("governance/escalation-rules.md");
    expect(msg).not.toContain("ai-systems/areas/agent-behavior");
  });
});
