/**
 * Tests for the steward-takeover path (AI-1596).
 *
 * Problem: when a deployment-stage delegate is absent, a steward stewarding
 * the ticket (Managing state) has no sanctioned way to drive it to done.
 * The only exit is break-glass `escape`, which leaves the ticket in Invalid
 * and loses clean closure semantics.
 *
 * AC1: stewardTakeover reassigns delegate to self without requiring the
 *      caller to already be the delegate. No break-glass required.
 * AC2: the resulting path reaches state:done with normal closure semantics
 *      (deploy → validated), NOT the escape terminal.
 * AC3: stewardTakeover sets proxy intent "steward-takeover" so the connector
 *      can surface it as an actionable path in stuck-delegate notifications.
 * AC4: regression — deployment-stage delegate absent → steward can drive to
 *      done via stewardTakeover + deploy; escape is not called.
 */

import { getSelfUser } from "../auth";
import { addComment, resolveUserWithHints, getIssue, updateIssue } from "../issues";
import { resolveLabelIds } from "../labels";
import { findSemanticState, SEMANTIC_STATE_MAP } from "../states";
import { deploy, validated, stewardTakeover } from "../semantic";
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

const LABEL_ID_MAP: Record<string, string> = {
  "state:intake": "label-intake",
  "state:write-tests": "label-write-tests",
  "state:implementation": "label-implementation",
  "state:code-review": "label-code-review",
  "state:deployment": "label-deployment",
  "state:host-deploy": "label-host-deploy",
  "state:ac-validate": "label-ac-validate",
  "state:escape": "label-escape",
  "wf:dev-impl": "label-wf-dev-impl",
};

// A deployment-stage ticket whose delegate (hanzo) is a different agent.
const deploymentIssueWithAbsentDelegate: any = {
  id: "issue-ai1566",
  identifier: "AI-1566",
  title: "Connector deploy stalled",
  team: { id: "team-ai", key: "AI", name: "AI Systems" },
  state: { id: "state-doing", name: "Doing", type: "started", position: 200 },
  labels: [
    { id: "label-deployment", name: "state:deployment", color: "#000" },
    { id: "label-wf-dev-impl", name: "wf:dev-impl", color: "#000" },
  ],
  assignee: null,
  delegate: { id: "user-hanzo", name: "Hanzo" },
};

// Self: Ai (the steward), who is NOT the current delegate.
const selfAi = { id: "user-ai", name: "Ai", email: "ai@test.com" };

const todoState = { id: "state-todo", name: "Todo", type: "unstarted", position: 0 };
const doingState = { id: "state-doing", name: "Doing", type: "started", position: 200 };
const doneState = { id: "state-done", name: "Done", type: "completed", position: 1000 };

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.LINEAR_PROXY_URL;
  mockGetIssue.mockResolvedValue(deploymentIssueWithAbsentDelegate);
  mockGetSelfUser.mockResolvedValue(selfAi);
  mockResolveLabelIds.mockImplementation(async (_teamId: string, names: string[]) =>
    names.map((n) => LABEL_ID_MAP[n] ?? `label-unknown-${n}`)
  );
  mockResolveUserWithHints.mockImplementation(async (name: string) => {
    const users: Record<string, any> = {
      Hanzo: { id: "user-hanzo", name: "Hanzo" },
      Ai: { id: "user-ai", name: "Ai" },
    };
    if (!users[name]) throw new Error(`Could not resolve "${name}"`);
    return users[name];
  });
  mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
    const map: Record<string, any> = {
      doing: doingState,
      todo: todoState,
      done: doneState,
    };
    return map[semantic] ?? todoState;
  });
  mockAddComment.mockResolvedValue({
    issueId: "issue-ai1566",
    commentId: "comment-uuid",
    commentUrl: "https://linear.app/test/comment/comment-uuid",
    commentCreatedAt: "2026-06-14T15:17:00Z",
    commentBodyLength: 10,
    body: "Steward takeover.",
  });
  mockUpdateIssue.mockImplementation(async (_id: string, input: any) => {
    // Simulate label changes: add added labels, remove removed labels.
    const currentLabels = deploymentIssueWithAbsentDelegate.labels;
    const removedIds: string[] = input.removedLabelIds ?? [];
    const addedIds: string[] = input.addedLabelIds ?? [];
    const afterLabels = [
      ...currentLabels.filter((l: any) => !removedIds.includes(l.id)),
      ...addedIds.map((id: string) => ({ id, name: Object.entries(LABEL_ID_MAP).find(([, v]) => v === id)?.[0] ?? id, color: "#000" })),
    ];
    return {
      ...deploymentIssueWithAbsentDelegate,
      delegate: input.delegateId === null
        ? null
        : input.delegateId === "user-ai"
          ? selfAi
          : deploymentIssueWithAbsentDelegate.delegate,
      assignee: "assigneeId" in input ? null : deploymentIssueWithAbsentDelegate.assignee,
      labels: afterLabels,
      state: input.stateId ? doneState : deploymentIssueWithAbsentDelegate.state,
    };
  });
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
});

// Helper: assert intent was set then cleared in order.
function expectIntentSetAndCleared(intent: string): void {
  expect(mockSetProxyIntent).toHaveBeenCalledWith(intent);
  expect(mockSetProxyIntent).toHaveBeenCalledWith(undefined);
  const calls = mockSetProxyIntent.mock.calls.map((c) => c[0]);
  const setIdx = calls.indexOf(intent);
  const clearIdx = calls.indexOf(undefined);
  expect(clearIdx).toBeGreaterThan(setIdx);
}

// ─── AC1: sanctioned takeover without requiring self-delegation ────────────────

describe("stewardTakeover", () => {
  it("AC1: reassigns delegate to self even when current delegate is another agent (absent)", async () => {
    const result = await stewardTakeover("AI-1566");

    // Caller is NOT current delegate (Hanzo), but takeover must succeed.
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-1566",
      expect.objectContaining({ delegateId: selfAi.id })
    );
    expect(result.delegate).toBe(selfAi.name);
  });

  it("AC3: sets proxy intent to 'steward-takeover' so connector can surface it as actionable", async () => {
    await stewardTakeover("AI-1566");
    expectIntentSetAndCleared("steward-takeover");
  });

  it("AC1: does NOT change the state label — only transfers delegate ownership", async () => {
    await stewardTakeover("AI-1566");

    // Must not mutate state:* labels; label change is delegate-only.
    const call = mockUpdateIssue.mock.calls[0][1];
    expect(call).not.toHaveProperty("addedLabelIds");
    expect(call).not.toHaveProperty("removedLabelIds");
    expect(call).not.toHaveProperty("stateId");
  });

  it("AC1: works when ticket has no current delegate (delegate is null)", async () => {
    mockGetIssue.mockResolvedValue({
      ...deploymentIssueWithAbsentDelegate,
      delegate: null,
    });

    const result = await stewardTakeover("AI-1566");

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-1566",
      expect.objectContaining({ delegateId: selfAi.id })
    );
    expect(result.delegate).toBe(selfAi.name);
  });

  it("AC1: works when ticket is in state:host-deploy (multi-stage stuck-deploy coverage)", async () => {
    mockGetIssue.mockResolvedValue({
      ...deploymentIssueWithAbsentDelegate,
      labels: [
        { id: "label-host-deploy", name: "state:host-deploy", color: "#000" },
        { id: "label-wf-dev-impl", name: "wf:dev-impl", color: "#000" },
      ],
    });

    const result = await stewardTakeover("AI-1566");

    expect(result.delegate).toBe(selfAi.name);
    expectIntentSetAndCleared("steward-takeover");
  });

  it("emits command name 'stewardTakeover' in result", async () => {
    const result = await stewardTakeover("AI-1566");
    expect(result.command).toBe("stewardTakeover");
  });

  it("accepts an optional comment posted alongside the takeover", async () => {
    await stewardTakeover("AI-1566", { comment: "Taking over stalled deploy." });
    expect(mockAddComment).toHaveBeenCalledWith("AI-1566", "Taking over stalled deploy.");
  });
});

// ─── AC2 + AC4: full closure path reaches done, not escape ───────────────────

describe("steward closure path: stewardTakeover → deploy → validated (AC2, AC4)", () => {
  it("AC4 regression: deployment-stage delegate absent → stewardTakeover + deploy succeeds; escape is not required", async () => {
    // Step 1: steward takes over — reassigns delegate to self.
    const takeoverResult = await stewardTakeover("AI-1566");
    expect(takeoverResult.delegate).toBe(selfAi.name);

    // After takeover, subsequent calls see self as delegate.
    mockGetIssue.mockResolvedValue({
      ...deploymentIssueWithAbsentDelegate,
      delegate: selfAi,
    });

    // Step 2: steward (now the delegate) runs deploy.
    const deployResult = await deploy("AI-1566");
    expect(deployResult.command).toBe("deploy");
    // deploy must apply state:ac-validate label and omit stateId (AI-1498).
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "AI-1566",
      expect.objectContaining({ addedLabelIds: expect.arrayContaining(["label-ac-validate"]) })
    );
    const deployCall = mockUpdateIssue.mock.calls.find((c) =>
      c[1].addedLabelIds?.includes("label-ac-validate")
    )!;
    expect(deployCall[1]).not.toHaveProperty("stateId");
  });

  it("AC2: the full path yields state:done with normal validated semantics, not escape terminal", async () => {
    // Simulate the ticket already at ac-validate after deploy.
    mockGetIssue.mockResolvedValue({
      ...deploymentIssueWithAbsentDelegate,
      delegate: selfAi,
      labels: [
        { id: "label-ac-validate", name: "state:ac-validate", color: "#000" },
        { id: "label-wf-dev-impl", name: "wf:dev-impl", color: "#000" },
      ],
    });
    // validated transitions to Done.
    mockFindSemanticState.mockImplementation(async (_teamId: string, semantic: string) => {
      if (semantic === "done") return doneState;
      return todoState;
    });
    mockUpdateIssue.mockResolvedValue({
      ...deploymentIssueWithAbsentDelegate,
      state: doneState,
      delegate: null,
      assignee: null,
      labels: [],
    });

    const result = await validated("AI-1566");

    expect(result.state).toBe("Done");
    expect(result.delegate).toBeNull();
    // The terminal here is Done — confirmed via closure semantics, not escape.
    expect(result.command).toBe("validated");
  });

  it("AC2: stewardTakeover result.state is NOT 'Invalid' (not escape terminal)", async () => {
    const result = await stewardTakeover("AI-1566");
    expect(result.state).not.toBe("Invalid");
  });
});
