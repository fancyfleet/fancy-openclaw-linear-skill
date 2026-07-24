/**
 * INF-204 — `linear transition <id> <move>`: the generic governed-transition verb.
 *
 * The connector's sprint-spawner workflow shipped `hold` / `start-cycle` moves
 * with no CLI wrapper, so dispatch messages advertised commands the installed
 * CLI could not emit ("unknown command 'hold'") and a governed leaf (LIF-143)
 * re-dispatched indefinitely with no discoverable exit. The confirmed interim
 * rescue was exactly what this verb now wraps: set the proxy intent header to
 * the move name and run executeTransition with omitStateId — the proxy resolves
 * legality and applies all effects.
 *
 * These pin the contract that makes the verb safe to keep generic:
 *
 *   AC1 — the intent header IS the move: setProxyIntent(move) before the
 *         mutation, cleared after, success or failure.
 *   AC2 — the CLI adds no local state logic: no stateId written, no delegate /
 *         assignee cleared by the CLI (the proxy's applyStateTransition is the
 *         sole writer; LIF-143's delegate-clear came from the connector).
 *   AC3 — move names are validated before any network call: the move goes into
 *         an HTTP header, so arbitrary strings must be rejected up front.
 *   AC4 — no proxy, no verb: without LINEAR_PROXY_URL there is no workflow
 *         engine to resolve the move, and the CLI must refuse rather than
 *         silently no-op (the AI-2053 lesson, inverted).
 */

import { getIssue, updateIssue, addComment, resolveUserWithHints } from "../issues";
import { setProxyIntent, setProxyTarget } from "../client";
import { transition } from "../semantic";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
  setProxyTarget: jest.fn(),
}));

jest.mock("../issues", () => ({
  addComment: jest.fn(),
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
  findStateByType: jest.fn(),
  findSemanticState: jest.fn(),
}));

jest.mock("../labels", () => ({ resolveLabelIds: jest.fn() }));

const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;
const mockSetProxyTarget = setProxyTarget as jest.MockedFunction<typeof setProxyTarget>;
const mockResolveUser = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;

// UUID deliberately ≠ identifier (the AI-2357 lesson).
const stuckIssue: any = {
  id: "uuid-stuck",
  identifier: "LIF-143",
  title: "stray sprint-spawner leaf",
  team: { id: "team-lif", key: "LIF" },
  state: { id: "state-evaluating", name: "Evaluating", type: "started" },
  assignee: null,
  delegate: { id: "user-mckell", name: "Mckell (CMO)" },
  labels: [{ name: "wf:sprint-spawner" }, { name: "state:evaluating" }],
};

// What the connector's applyStateTransition left behind on LIF-143: terminal
// state stamped, delegate cleared — all by the proxy, none by the CLI. The
// post-transition verify (AI-1769) re-reads the issue and requires the state:*
// label set to have changed, so the mocks must show the proxy's work.
const heldIssue: any = {
  ...stuckIssue,
  state: { id: "state-invalid", name: "Invalid", type: "canceled" },
  delegate: null,
  labels: [{ name: "wf:sprint-spawner" }, { name: "state:__terminal_hold__" }],
};

const PROXY_URL = "http://127.0.0.1:8787";

beforeEach(() => {
  jest.resetAllMocks();
  process.env.LINEAR_PROXY_URL = PROXY_URL;
  // First read = pre-transition snapshot; later reads = post-proxy state.
  mockGetIssue.mockResolvedValueOnce(stuckIssue).mockResolvedValue(heldIssue);
  mockResolveUser.mockResolvedValue({ id: "user-mckell", name: "Mckell (CMO)", app: true } as any);
  mockUpdateIssue.mockResolvedValue(heldIssue);
  mockAddComment.mockResolvedValue({
    commentId: "comment-1",
    commentUrl: "https://linear.app/c/1",
    commentCreatedAt: "2026-07-20T00:00:00.000Z",
    commentBodyLength: 10,
  } as any);
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
});

describe("INF-204: linear transition <id> <move>", () => {
  it("AC1 — sets the proxy intent header to the move name and clears it after", async () => {
    await transition("LIF-143", "hold");

    expect(mockSetProxyIntent).toHaveBeenCalledWith("hold");
    // Cleared in the finally — last call must be the reset.
    const calls = mockSetProxyIntent.mock.calls;
    expect(calls[calls.length - 1]).toEqual([undefined]);
  });

  it("AC1 — clears the intent even when the transition throws", async () => {
    mockUpdateIssue.mockRejectedValue(new Error("proxy: illegal move in state"));

    await expect(transition("LIF-143", "start-cycle")).rejects.toThrow("illegal move");

    const calls = mockSetProxyIntent.mock.calls;
    expect(calls[0]).toEqual(["start-cycle"]);
    expect(calls[calls.length - 1]).toEqual([undefined]);
  });

  it("AC2 — writes no stateId and clears no ownership: the proxy is the sole state writer", async () => {
    await transition("LIF-143", "hold");

    // Comment-less proxy-governed transition → empty trigger mutation (AI-1840).
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    const payload = mockUpdateIssue.mock.calls[0][1];
    expect(payload).not.toHaveProperty("stateId");
    expect(payload).not.toHaveProperty("delegateId");
    expect(payload).not.toHaveProperty("assigneeId");
  });

  it("AC2 — a comment carries the intent instead of the trigger mutation", async () => {
    await transition("LIF-143", "hold", { comment: "Loop retired; canonical is LIF-45." });

    expect(mockAddComment).toHaveBeenCalledTimes(1);
    // The comment IS the proxy trigger — no issueUpdate should follow it.
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("AC3 — rejects non-kebab-case move names before any network call", async () => {
    for (const bad of ["Hold", "hold move", "hold\nX-Evil: 1", "", "-hold", "über"]) {
      await expect(transition("LIF-143", bad)).rejects.toThrow(/Invalid move name/);
    }
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockSetProxyIntent).not.toHaveBeenCalled();
  });

  it("AC4 — refuses to run without the governed proxy", async () => {
    delete process.env.LINEAR_PROXY_URL;

    await expect(transition("LIF-143", "hold")).rejects.toThrow(/LINEAR_PROXY_URL/);
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it("routes --target through the proxy target header like continue-workflow", async () => {
    // The proxy delegates to the target; the persistence check (step 11)
    // compares against the re-read delegate, so the post state must carry it.
    const delegated = { ...heldIssue, delegate: { id: "user-mckell", name: "Mckell (CMO)" } };
    mockUpdateIssue.mockResolvedValue(delegated);
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValueOnce(stuckIssue).mockResolvedValue(delegated);

    await transition("LIF-143", "start-cycle", { target: "Mckell (CMO)" });

    expect(mockSetProxyTarget).toHaveBeenCalledWith("Mckell (CMO)");
    const calls = mockSetProxyTarget.mock.calls;
    expect(calls[calls.length - 1]).toEqual([undefined]);
  });
});
