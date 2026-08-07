/**
 * INF-1276 — the skill CLI must treat `_workflowTransition.status ===
 * "blocked"` as a thrown error and surface the blocker `detail` to the
 * caller.
 *
 * AC map (verbatim from the ticket):
 * - AC4: The Linear skill CLI treats `_workflowTransition.status ===
 *   "blocked"` as a thrown error and surfaces `detail` to the caller.
 *
 * The defect (confirmed by Grover's live repro on origin/main @ 41e720bb):
 * `linearGraphQL()` (src/client.ts) only throws when
 * `_workflowTransition.status === "failed"`. A gate-blocked governed forward
 * (e.g. the INF-1060 push-before-claim gate on a comment-carried `submit`)
 * returns a nominally-successful GraphQL payload (`data.commentCreate.success:
 * true`) with the decline carried only in the sibling
 * `_workflowTransition: { status: "blocked", code: "push-before-claim",
 * detail: "..." }` field. The CLI drops that machine-readable decline on the
 * floor and the agent retries blindly while comments keep posting (the
 * LIF-386/387/388 blind-retry pattern).
 *
 * Today these tests fail: the `status: "blocked"` signal is not checked at
 * all, and `WorkflowTransitionSignal` doesn't even carry `code`/`detail`.
 * Once fixed, the CLI throws a `LinearApiError` whose message contains the
 * blocker `detail` (and the `WORKFLOW_TRANSITION_FAILED`-style code is
 * extended to the blocked case), and the signal type accepts `code`/`detail`.
 */

import axios from "axios";
import { linearGraphQL, LinearApiError, setProxyIntent } from "../client";

jest.mock("axios");
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  ensureApiKey: jest.fn(() => "test-api-key"),
  resolveAgentName: jest.fn(() => ({ name: "igor", sources: [] })),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** The exact blocked-signal shape the connector attaches today (verified
 *  against origin/main): nominally-successful `data` + a sibling
 *  `_workflowTransition` carrying the decline. */
function withBlockedWorkflowTransition(body: unknown, code = "push-before-claim", detail?: string) {
  return {
    ...(body as object),
    _workflowTransition: {
      status: "blocked",
      code,
      detail:
        detail ??
        "push-before-claim: this implementation submit supplied no published artifact. Push your branch to origin, then re-run the submit naming the branch and the commit SHA (the reviewer reviews the pushed commit, not your working tree).",
    },
  };
}

const OLD_ENV = process.env.LINEAR_PROXY_URL;

beforeEach(() => {
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
  (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn(() => false);
  process.env.LINEAR_PROXY_URL = "https://proxy.example.test/graphql";
  setProxyIntent(undefined);
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.LINEAR_PROXY_URL;
  else process.env.LINEAR_PROXY_URL = OLD_ENV;
  setProxyIntent(undefined);
});

describe("INF-1276 AC4 — linearGraphQL() must fail loud on an embedded _workflowTransition 'blocked' signal", () => {
  it("throws (does not silently return) when the response carries _workflowTransition: { status: 'blocked' } alongside nominally-successful data", async () => {
    mockedAxios.get.mockResolvedValue({ data: {}, headers: {} });
    mockedAxios.post.mockResolvedValue({
      data: withBlockedWorkflowTransition({
        data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
      }),
    });

    setProxyIntent("submit");

    await expect(
      linearGraphQL("mutation { commentCreate(input: { issueId: \"issue-1\", body: \"submitted\" }) { success } }")
    ).rejects.toThrow();
  });

  it("surfaces the blocker detail (push-before-claim no-artifact reason) in the thrown error", async () => {
    mockedAxios.get.mockResolvedValue({ data: {}, headers: {} });
    mockedAxios.post.mockResolvedValue({
      data: withBlockedWorkflowTransition(
        {
          data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
        },
        "push-before-claim",
        "push-before-claim: this implementation submit supplied no published artifact. Push your branch to origin, then re-run the submit."
      ),
    });

    setProxyIntent("submit");

    await expect(
      linearGraphQL("mutation { commentCreate(input: { issueId: \"issue-1\", body: \"submitted\" }) { success } }")
    ).rejects.toThrow(/push-before-claim/);
  });

  it("surfaces the no-origin-repository-context detail variant", async () => {
    mockedAxios.get.mockResolvedValue({ data: {}, headers: {} });
    mockedAxios.post.mockResolvedValue({
      data: withBlockedWorkflowTransition(
        {
          data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
        },
        "push-before-claim",
        "push-before-claim: cannot validate feature/INF-1276-test@01234567 because this ticket has no origin repository context. Add a repo:* label or GitHub attachment, then re-run the submit with the pushed branch and commit SHA."
      ),
    });

    setProxyIntent("submit");

    await expect(
      linearGraphQL("mutation { commentCreate(input: { issueId: \"issue-1\", body: \"submitted\" }) { success } }")
    ).rejects.toThrow(/no origin repository context/);
  });

  it("still surfaces the comment-posted note when the comment had already posted (AC3 CLI-side)", async () => {
    mockedAxios.get.mockResolvedValue({ data: {}, headers: {} });
    mockedAxios.post.mockResolvedValue({
      data: withBlockedWorkflowTransition(
        {
          data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
        },
        "push-before-claim",
        "push-before-claim: no published artifact. The review comment was posted, but the transition did not apply. Push your branch and re-run the submit."
      ),
    });

    setProxyIntent("submit");

    const err = await linearGraphQL(
      "mutation { commentCreate(input: { issueId: \"issue-1\", body: \"submitted\" }) { success } }"
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearApiError);
    expect(String((err as Error).message)).toMatch(/comment was posted|comment.*posted/i);
    expect(String((err as Error).message)).not.toMatch(/rolled back/i);
  });
});
