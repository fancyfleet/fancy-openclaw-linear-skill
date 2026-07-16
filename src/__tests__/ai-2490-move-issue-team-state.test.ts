/**
 * AI-2490: `issue-move-team` must surface a state remap as a *change*, and must
 * accept an explicit `--state` for the target team.
 *
 * Background (established across two write-tests passes): the command already
 * prints the post-move state name in both output modes. Printing it was never
 * the gap. The gap is that nothing flags the state as *changed* — detecting a
 * remap is a delta (pre-move vs post-move), and the caller only ever sees the
 * post-move value. That is what produced the reported silent stall: AI (To Do)
 * → INF landed in `Thinking`, `linear queue` excludes `Thinking`, and the issue
 * was delegated but never dispatchable with nothing in the output saying so.
 *
 * Seam under test (locked here, per the ticket's "TDD should be briefed on the
 * chosen approach" note): a `moveIssueTeam(issueId, teamId, opts)` exported from
 * `src/issues.ts`, taking an ALREADY-RESOLVED teamId — the action closure keeps
 * calling `resolveTeamId` — and returning the post-move issue augmented with
 * `stateChanged` / `sourceState`.
 *
 * These tests drive the REAL moveIssueTeam against a mocked `linearGraphQL`
 * rather than mocking getIssue/updateIssue. Two reasons:
 *   1. getIssue/updateIssue live in the same module as moveIssueTeam, so they
 *      cannot be cleanly mocked from outside it.
 *   2. The atomicity AC is literally "applied in the same `issueUpdate` mutation
 *      as `teamId`". Asserting on the mutation's variables proves that; asserting
 *      on a mocked updateIssue call would only prove the arguments were bundled
 *      before an internal boundary that the implementer is free to move.
 *
 * AC coverage map:
 *   AC1 → "warns and marks stateChanged when the target team remaps the state"
 *         + "reads the pre-move state before mutating"
 *   AC2 → "stays silent when the resolved state name is unchanged"
 *   AC3 → "--state ..." describe block (resolve-in-target-team, atomic apply,
 *         unknown-state error)
 *   AC4 → satisfied structurally by importing moveIssueTeam at all; the suite
 *         never spawns dist/index.js for behavior, only for CLI option surface.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { linearGraphQL } from "../client";
import { moveIssueTeam } from "../issues";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
}));

/**
 * findStateByName → getWorkflowStates caches each team's states under
 * os.homedir() and reads that cache before hitting the API. Without redirection
 * these tests would resolve against whichever fixture ran first, or against a
 * real cache on the box. Setting process.env.HOME does not work here — jest's
 * `node` environment gives the test its own `process`, while native
 * `os.homedir()` reads the real one. Mock the module boundary instead.
 * (Same rationale as ai-2445-find-state-by-type.test.ts.)
 */
let mockHomeDir: string;
jest.mock("node:os", () => {
  const actual = jest.requireActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mockHomeDir ?? actual.homedir() };
});

const mockLinearGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

const SOURCE_TEAM_ID = "11111111-1111-1111-1111-111111111111";
const TARGET_TEAM_ID = "22222222-2222-2222-2222-222222222222";
const ISSUE_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** Workflow states for the target (INF) team — deliberately includes both the
 *  remap destination (`Thinking`) and a same-name equivalent (`To Do`). */
const TARGET_TEAM_STATES = [
  { id: "state-todo-inf", name: "To Do", type: "unstarted", color: "#e2e2e2", position: 1000 },
  { id: "state-thinking-inf", name: "Thinking", type: "started", color: "#f2c94c", position: 1100 },
  { id: "state-doing-inf", name: "Doing", type: "started", color: "#5e6ad2", position: 1200 },
];

function issueFixture(stateName: string, stateId: string) {
  return {
    id: ISSUE_UUID,
    identifier: "AI-1",
    title: "Some issue",
    description: "",
    priority: 3,
    url: "https://linear.app/fancymatt/issue/AI-1",
    createdAt: "2026-07-16T09:00:00.000Z",
    updatedAt: "2026-07-16T09:00:00.000Z",
    state: { id: stateId, name: stateName, type: "unstarted", color: "#e2e2e2", position: 1000 },
    team: { id: SOURCE_TEAM_ID, key: "AI", name: "OLD AI Systems" },
    assignee: null,
    delegate: null,
    project: null,
    projectMilestone: null,
    labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    comments: { nodes: [] },
    children: { nodes: [] },
  };
}

/**
 * Route mocked GraphQL by operation. `preMoveState` is what a read sees before
 * the issueUpdate mutation fires; `postMoveState` is what it sees after — this
 * is how the target team's remap is simulated.
 */
function mockTransport(options: {
  preMoveState: { name: string; id: string };
  postMoveState: { name: string; id: string };
  states?: typeof TARGET_TEAM_STATES;
}) {
  let mutated = false;
  const calls: { issueUpdateInputs: Record<string, unknown>[] } = { issueUpdateInputs: [] };

  mockLinearGraphQL.mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes("issueUpdate")) {
      mutated = true;
      calls.issueUpdateInputs.push((variables?.input ?? {}) as Record<string, unknown>);
      return { issueUpdate: { success: true, issue: { id: ISSUE_UUID } } } as never;
    }

    if (query.includes("WorkflowStates")) {
      return { team: { id: TARGET_TEAM_ID, key: "INF", states: { nodes: options.states ?? TARGET_TEAM_STATES } } } as never;
    }

    const current = mutated ? options.postMoveState : options.preMoveState;

    if (query.includes("IssueByIdentifier")) {
      return { issues: { nodes: [issueFixture(current.name, current.id)] } } as never;
    }
    if (query.includes("IssueDetail")) {
      return { issue: issueFixture(current.name, current.id) } as never;
    }

    throw new Error(`Unexpected GraphQL operation in test: ${query.slice(0, 80)}`);
  });

  return calls;
}

let stderrSpy: jest.SpyInstance;
let stderrOutput: string;

beforeEach(async () => {
  jest.resetAllMocks();
  mockHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai2490-home-"));
  stderrOutput = "";
  // The command writes warnings with process.stderr.write (matching the existing
  // no-orphan warning in createIssue), so capture at that boundary.
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrOutput += String(chunk);
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("AI-2490 AC1: warn when the target team remaps the state", () => {
  test("warns on stderr and marks stateChanged when the resolved state name differs", async () => {
    mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      postMoveState: { name: "Thinking", id: "state-thinking-inf" },
    });

    const result = await moveIssueTeam("AI-1", TARGET_TEAM_ID);

    // The caller must be able to detect the remap from the returned value alone,
    // without a second read — this is the whole point of the ticket.
    expect(result.stateChanged).toBe(true);
    expect(result.sourceState).toEqual(expect.objectContaining({ name: "To Do" }));
    expect(result.state).toEqual(expect.objectContaining({ name: "Thinking" }));

    expect(stderrOutput).toContain('Warning: state remapped from "To Do" to "Thinking" in target team.');
  });

  test("reads the pre-move state before issuing the mutation", async () => {
    mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      postMoveState: { name: "Thinking", id: "state-thinking-inf" },
    });

    await moveIssueTeam("AI-1", TARGET_TEAM_ID);

    // A read must precede the mutation. Without it there is no source state to
    // diff against, and stateChanged degenerates into a guess.
    const operations = mockLinearGraphQL.mock.calls.map(([query]) => query as string);
    const firstRead = operations.findIndex((q) => q.includes("IssueByIdentifier") || q.includes("IssueDetail"));
    const mutation = operations.findIndex((q) => q.includes("issueUpdate"));

    expect(firstRead).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(firstRead).toBeLessThan(mutation);
  });
});

describe("AI-2490 AC2: silent when the state name is unchanged", () => {
  test("emits no warning and does not set stateChanged when source and resolved names match", async () => {
    mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      // Same NAME, different ID — this is the ordinary cross-team move: state IDs
      // are team-scoped, so the ID always changes. Only a name change is a remap.
      postMoveState: { name: "To Do", id: "state-todo-inf" },
    });

    const result = await moveIssueTeam("AI-1", TARGET_TEAM_ID);

    expect(result.stateChanged).toBeFalsy();
    expect(result.state).toEqual(expect.objectContaining({ name: "To Do" }));
    expect(stderrOutput).not.toContain("state remapped");
  });
});

describe("AI-2490 AC3: --state resolves against the target team and applies atomically", () => {
  test("resolves the named state in the TARGET team's workflow", async () => {
    mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      postMoveState: { name: "Doing", id: "state-doing-inf" },
    });

    await moveIssueTeam("AI-1", TARGET_TEAM_ID, { state: "Doing" });

    // The state list must be fetched for the TARGET team. Resolving against the
    // source team would reproduce the very bug this ticket exists to fix.
    const statesCall = mockLinearGraphQL.mock.calls.find(([query]) => (query as string).includes("WorkflowStates"));
    expect(statesCall).toBeDefined();
    expect(statesCall?.[1]).toEqual(expect.objectContaining({ teamId: TARGET_TEAM_ID }));
  });

  test("applies stateId and teamId in a single issueUpdate mutation", async () => {
    const calls = mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      postMoveState: { name: "Doing", id: "state-doing-inf" },
    });

    await moveIssueTeam("AI-1", TARGET_TEAM_ID, { state: "Doing" });

    // Atomicity: exactly one mutation carrying BOTH fields. Two sequential
    // mutations would leave a window where the issue sits in the target team in
    // a remapped state — the stall this ticket is closing.
    expect(calls.issueUpdateInputs).toHaveLength(1);
    expect(calls.issueUpdateInputs[0]).toEqual(
      expect.objectContaining({ teamId: TARGET_TEAM_ID, stateId: "state-doing-inf" })
    );
  });

  test("accepts a state alias and resolves it against the target team", async () => {
    const calls = mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      postMoveState: { name: "To Do", id: "state-todo-inf" },
    });

    // findStateByName already understands STATE_ALIASES ("todo" → "To Do"); the
    // flag must go through that resolver rather than doing its own exact match.
    await moveIssueTeam("AI-1", TARGET_TEAM_ID, { state: "todo" });

    // Assert on the mutation input, not on the returned state name: the fixture
    // reports "To Do" post-move whether or not --state was honored, so a
    // name-only assertion passes against an implementation that ignores the flag
    // entirely. The resolved ID reaching the mutation is the real proof.
    expect(calls.issueUpdateInputs[0]).toEqual(
      expect.objectContaining({ stateId: "state-todo-inf" })
    );
  });

  test("errors clearly on a state that does not exist in the target team, without mutating", async () => {
    const calls = mockTransport({
      preMoveState: { name: "To Do", id: "state-todo-ai" },
      postMoveState: { name: "To Do", id: "state-todo-inf" },
    });

    // "Icebox" is absent from TARGET_TEAM_STATES. A silent fallback here is what
    // the AC explicitly forbids.
    await expect(moveIssueTeam("AI-1", TARGET_TEAM_ID, { state: "Icebox" })).rejects.toThrow(/Icebox/);

    // And the move must not have happened: a partial apply would strand the issue
    // in the target team in an unpredictable state — worse than refusing.
    expect(calls.issueUpdateInputs).toHaveLength(0);
  });
});
