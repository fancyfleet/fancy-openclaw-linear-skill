/**
 * INF-1516 — `refuse-work` must forward the explicit delegate target so a
 * governed multi-body role seats THAT agent instead of re-pooling to bodies[0].
 *
 * Split from INF-1513 (defect 1): on a governed `implementation` ticket whose
 * owner role has multiple candidate bodies, `linear refuse-work <id> <agent>`
 * silently dropped the target. `refuse-work` is a governed transition command,
 * and the connector's `resolveTransitionDelegate` honours `cliTarget` first
 * (workflow-gate.ts) — but ONLY if the CLI sends the X-Openclaw-Linear-Target
 * header. `handoffWork` already forwards its target on governed tickets via
 * `setProxyTarget`; `refuseWork` never did, so the connector fell through to
 * role re-pooling (the INF-1507 / ENG-58 / ENG-43 stewardship-reseat stalls).
 *
 * Fix (defect 1, part A): `refuseWork` calls
 * `setProxyTarget(normalizeAgentTarget(delegateName))` and clears it in
 * `finally`, exactly like the governed `handoffWork` path.
 *
 * INF-1628: part A originally used a `resolveAgentSlugForDisplayName` slug-map
 * that carried stale parenthesized display names and broke every slug-targeted
 * verb once Matt de-parenthesized the agents' Linear names. The map is gone;
 * `normalizeAgentTarget` derives the bare slug from the typed input (first token,
 * lowercased) with no string table. Covered by the INF-1628 cases below.
 */

import { refuseWork } from "../semantic";
import { addComment, getIssue, updateIssue, resolveUserWithHints, normalizeAgentTarget } from "../issues";
import { getSelfUser } from "../auth";
import { findSemanticState } from "../states";
import { setProxyIntent, setProxyTarget } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
  setProxyIntent: jest.fn(),
  setProxyTarget: jest.fn(),
  setProxyCodeArtifact: jest.fn(),
  setProxySubstitutionReason: jest.fn(),
  setProxyCommentSatisfiedBy: jest.fn(),
}));

jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  getSelfUser: jest.fn(),
}));

jest.mock("../issues", () => ({
  ...jest.requireActual("../issues"),
  addComment: jest.fn(),
  findUserByName: jest.fn(),
  resolveUserWithHints: jest.fn(),
  getIssue: jest.fn(),
  updateIssue: jest.fn(),
}));

jest.mock("../states", () => ({
  ...jest.requireActual("../states"),
  findSemanticState: jest.fn(),
}));

jest.mock("../boards", () => ({
  getComments: jest.fn().mockResolvedValue([]),
  getIssueHistory: jest.fn().mockResolvedValue([]),
}));

const mockAddComment = addComment as jest.MockedFunction<typeof addComment>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockGetSelfUser = getSelfUser as jest.MockedFunction<typeof getSelfUser>;
const mockResolveUserWithHints = resolveUserWithHints as jest.MockedFunction<typeof resolveUserWithHints>;
const mockFindSemanticState = findSemanticState as jest.MockedFunction<typeof findSemanticState>;
const mockSetProxyIntent = setProxyIntent as jest.MockedFunction<typeof setProxyIntent>;
const mockSetProxyTarget = setProxyTarget as jest.MockedFunction<typeof setProxyTarget>;

const TEAM = { id: "team-inf", key: "INF", name: "Infra" };
const STEWARD = { id: "user-astrid", name: "Astrid (CPO)", app: true };
const WORKER = { id: "user-igor", name: "Igor (Back End Dev)", app: true };
const CHARLES = { id: "user-charles", name: "Charles (Engineering Head)", app: true };
const TODO = { id: "s-todo", name: "To Do", type: "unstarted" };

/** A `dev-impl`-workflow ticket in `implementation`, delegate = the steward. */
const govImplIssue: any = {
  id: "issue-1507",
  identifier: "INF-1507",
  title: "Governed implementation ticket, multi-body role",
  team: TEAM,
  state: { id: "s-doing", name: "In Progress", type: "started" },
  delegate: STEWARD,
  assignee: null,
  labels: [{ name: "wf:dev-impl" }, { name: "state:implementation" }],
};

/** Post-refuse shape the proxy's governed transition produces (delegate reseated). */
const reseat = (delegate: any): any => ({ ...govImplIssue, delegate });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LINEAR_PROXY_URL = "http://localhost:3100/proxy";
  process.env.LINEAR_POST_TRANSITION_VERIFY_DELAY_MS = "0";
  mockGetSelfUser.mockResolvedValue(STEWARD as any);
  mockResolveUserWithHints.mockResolvedValue(WORKER as any);
  mockFindSemanticState.mockResolvedValue(TODO as any);
  // Pre-fetch = steward-delegated; post-transition re-fetch/update = reseated worker.
  mockGetIssue.mockResolvedValueOnce(govImplIssue).mockResolvedValue(reseat(WORKER));
  mockUpdateIssue.mockResolvedValue(reseat(WORKER));
  mockAddComment.mockResolvedValue({
    issueId: "issue-1507",
    commentId: "comment-new",
    commentUrl: "https://linear.app/c/new",
    commentCreatedAt: "2026-08-13T22:40:00Z",
    commentBodyLength: 10,
    body: "x",
  } as any);
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
  delete process.env.LINEAR_POST_TRANSITION_VERIFY_DELAY_MS;
});

describe("INF-1516 defect 1A — refuse-work forwards the explicit target", () => {
  it("sets the proxy target to the resolved slug, then clears it (was never set before)", async () => {
    await refuseWork("INF-1507", "Igor (Back End Dev)", {
      comment: "Not mine to implement — reseating the bound worker.",
    });

    // Before the fix, refuseWork never called setProxyTarget, so the connector
    // received no cliTarget and re-pooled the multi-body role to bodies[0].
    expect(mockSetProxyTarget).toHaveBeenNthCalledWith(1, "igor");
    expect(mockSetProxyTarget).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps setting the refuse-work intent and clears it (unchanged behavior)", async () => {
    await refuseWork("INF-1507", "Igor (Back End Dev)", { comment: "reseat" });
    expect(mockSetProxyIntent).toHaveBeenNthCalledWith(1, "refuse-work");
    expect(mockSetProxyIntent).toHaveBeenLastCalledWith(undefined);
  });

  it("forwards the bare slug when the target is given as a (possibly parenthesized) display name", async () => {
    mockResolveUserWithHints.mockResolvedValue(CHARLES as any);
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValueOnce(govImplIssue).mockResolvedValue(reseat(CHARLES));
    mockUpdateIssue.mockResolvedValue(reseat(CHARLES));
    await refuseWork("INF-1507", "Charles (Engineering Head)", { comment: "reseat to engineering head" });

    // INF-1628: the header must carry the bare slug the connector's getAgent(cliTarget)
    // matches against. normalizeAgentTarget takes the first token lowercased, so a
    // leftover parenthesized display name still collapses to "charles" — no slug table.
    expect(mockSetProxyTarget).toHaveBeenNthCalledWith(1, "charles");
  });
});

// INF-1628: normalizeAgentTarget replaces the drift-prone AGENT_SLUG_MAP. It
// carries whatever was typed to the proxy as a bare, lowercased first-token slug.
describe("INF-1628 — normalizeAgentTarget (proxy target, table-free)", () => {
  it.each([
    ["charles", "charles"],       // bare slug passes through
    ["Grover", "grover"],         // de-parenthesized display name → slug
    ["ASTRID", "astrid"],         // case-insensitive
    ["Igor (Back End Dev)", "igor"], // leftover parenthetical → first token
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeAgentTarget(input)).toBe(expected);
  });

  it("passes a UUID through lowercased (hex — lossless, no whitespace)", () => {
    expect(normalizeAgentTarget("336FB582-6613-4E86-A83E-5B42FD269E5D"))
      .toBe("336fb582-6613-4e86-a83e-5b42fd269e5d");
  });
});
