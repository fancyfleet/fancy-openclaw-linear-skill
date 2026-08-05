/**
 * INF-1261 — CLI can drive & verify governed recovery: rewind/migrate-state
 * verbs + fail-loud on unapplied writes.
 *
 * FAILING TESTS ONLY (test-authoring phase, no implementation). Confirmed
 * current-state gaps this suite proves:
 *
 *   AC1 gap: neither `rewind` nor `migrate-state` is a registered CLI command
 *   (src/index.ts). The only related thing is the hidden/deprecated `status
 *   <id> <state>` command, which resolves the target state CLIENT-SIDE via
 *   `findStateByName` and sends no intent header at all — the anti-pattern
 *   these new verbs must avoid.
 *
 *   AC2 gap: `linearGraphQL()` (src/client.ts) types its response as
 *   `{ data?, errors? }` and returns only `response.data.data`. A proxy-side
 *   no-op-write signal returned as a sibling field on the same JSON body
 *   (`_workflowTransition: { status: "failed", ... }`) is silently dropped
 *   before it ever reaches a command handler — a nominally-successful mutation
 *   response is reported to the user as success even when the write did not
 *   apply.
 *
 * Test strategy: drive the REAL BUILT CLI (`dist/index.js`) as a subprocess
 * against a local mock proxy server (Part A, C), asserting on the raw
 * outgoing request the mock server observed and on the CLI's stdout/stderr/
 * exit code. This is a black-box boundary that doesn't require guessing the
 * implementer's internal module/function names for the not-yet-written
 * `rewind`/`migrate-state` commands. Part B asserts directly against
 * `linearGraphQL()` — the shared low-level function every write verb
 * (`complete`, `submit`, `handoff`, transitions, and the new recovery verbs)
 * funnels through — matching the investigation note that the AC2 gap should
 * be proven at that exact layer.
 *
 * Requires `npm run build` first (CI=1 on non-main branches — see
 * ai-2491-cli-registration.test.ts / ai-2490-move-team-state-flag-cli.test.ts
 * for the same precondition and subprocess convention this suite follows).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import axios from "axios";
import { linearGraphQL, setProxyIntent } from "../client";

// Only used by Part B (in-process unit tests). Part A/C spawn a real
// `dist/index.js` subprocess, which runs in its own Node process and is
// entirely unaffected by these jest module mocks.
jest.mock("axios");
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  ensureApiKey: jest.fn(() => "test-api-key"),
  resolveAgentName: jest.fn(() => ({ name: "igor", sources: [] })),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const repoRoot = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Part A/C shared harness: real CLI subprocess against a local mock proxy.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface MockProxy {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/**
 * Minimal proxy stand-in: answers the CLI's version-compatibility preflight
 * (GET) with an empty body (no floor set, so no version gate), and answers
 * every POST (a GraphQL request) via `respond`. Captures every request so
 * tests can assert on headers/body the CLI actually sent — not on internals.
 */
function startMockProxy(
  respond: (req: CapturedRequest, postIndex: number) => { status?: number; body: any }
): Promise<MockProxy> {
  const requests: CapturedRequest[] = [];
  let postCount = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: any;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        const captured: CapturedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body,
        };
        requests.push(captured);

        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({}));
          return;
        }

        const { status = 200, body: respBody } = respond(captured, postCount++);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respBody));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/graphql`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function runCli(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LINEAR_API_KEY: "test-key",
        // Every call sets this explicitly (empty string or a mock URL) so a
        // real LINEAR_PROXY_URL leaking from the ambient dev-container
        // environment can't route these tests at the live connector.
        LINEAR_PROXY_URL: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => resolve({ stdout, stderr: String(error), code: 1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

/** Shape `updateIssue()` (src/issues.ts) expects from an `issueUpdate` mutation. */
function issueUpdateBody(stateName: string) {
  return {
    data: {
      issueUpdate: {
        success: true,
        issue: { id: "issue-1", identifier: "INF-9001", state: { id: "s-target", name: stateName, type: "started" } },
      },
    },
  };
}

/** Shape `getIssue()` (src/issues.ts) expects from an `issue` query. */
function issueDetailBody(stateName: string) {
  return {
    data: {
      issue: {
        id: "issue-1",
        identifier: "INF-9001",
        title: "Stranded ticket",
        team: { id: "team-inf", key: "INF", name: "Infra" },
        state: { id: "s-target", name: stateName, type: "started" },
        assignee: null,
        delegate: null,
        labels: { nodes: [] },
      },
    },
  };
}

/** A no-op-write signal sibling to `data` — the shape the proxy attaches per the ticket's confirmed mechanism (AI-1762/AI-2554). */
function withFailedWorkflowTransition(body: any, reason = "state unchanged after write") {
  return { ...body, _workflowTransition: { status: "failed", reason } };
}

const REGISTERED_STATE_LOOKUP_QUERY = /workflowStates|teamStates|\bstates\s*\(/i;

// ---------------------------------------------------------------------------
// Part A — AC1: `rewind` and `migrate-state` exist on the shipped CLI, use
// verb-specific headers, and resolve the target state server-side.
// ---------------------------------------------------------------------------

describe("INF-1261 AC1 — `rewind <id> --target <state>` is a real CLI verb", () => {
  let proxy: MockProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it("is registered as a top-level, discoverable (non-hidden) command", async () => {
    const { stdout, code } = await runCli(["--help"], {});
    expect(code).toBe(0);
    expect(stdout).toMatch(/^\s+rewind\b/m);
  });

  it("sends X-Openclaw-Linear-Intent: rewind and X-Openclaw-Rewind-Target: <raw state>, never the generic X-Openclaw-Linear-Target header, and performs no client-side state-lookup query", async () => {
    proxy = await startMockProxy((req) => {
      const query: string = typeof req.body?.query === "string" ? req.body.query : "";
      return { body: query.includes("issueUpdate") ? issueUpdateBody("In Review") : issueDetailBody("In Review") };
    });

    const { code, stderr } = await runCli(["rewind", "INF-9001", "--target", "In Review"], {
      LINEAR_PROXY_URL: proxy.url,
    });

    expect(stderr).not.toMatch(/unknown command|unknown option/i);
    expect(code).toBe(0);

    const posts = proxy.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.headers["x-openclaw-linear-intent"]).toBe("rewind");
      expect(p.headers["x-openclaw-rewind-target"]).toBe("In Review");
      expect(p.headers["x-openclaw-linear-target"]).toBeUndefined();
      const query: string = typeof p.body?.query === "string" ? p.body.query : "";
      expect(query).not.toMatch(REGISTERED_STATE_LOOKUP_QUERY);
    }
  });

  it("requires --target and fails with a usage error rather than proceeding without one", async () => {
    const { code, stderr } = await runCli(["rewind", "INF-9001"], {});
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--target|required option/i);
  });
});

describe("INF-1261 AC1 — `migrate-state <id> --target <state>` is a real CLI verb", () => {
  let proxy: MockProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it("is registered as a top-level, discoverable (non-hidden) command", async () => {
    const { stdout, code } = await runCli(["--help"], {});
    expect(code).toBe(0);
    expect(stdout).toMatch(/^\s+migrate-state\b/m);
  });

  it("sends X-Openclaw-Linear-Intent: migrate-state and X-Openclaw-Migrate-Target: <raw state>, never the generic X-Openclaw-Linear-Target header, and performs no client-side state-lookup query", async () => {
    proxy = await startMockProxy((req) => {
      const query: string = typeof req.body?.query === "string" ? req.body.query : "";
      return { body: query.includes("issueUpdate") ? issueUpdateBody("Backlog") : issueDetailBody("Backlog") };
    });

    const { code, stderr } = await runCli(["migrate-state", "INF-9001", "--target", "Backlog"], {
      LINEAR_PROXY_URL: proxy.url,
    });

    expect(stderr).not.toMatch(/unknown command|unknown option/i);
    expect(code).toBe(0);

    const posts = proxy.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p.headers["x-openclaw-linear-intent"]).toBe("migrate-state");
      expect(p.headers["x-openclaw-migrate-target"]).toBe("Backlog");
      expect(p.headers["x-openclaw-linear-target"]).toBeUndefined();
      const query: string = typeof p.body?.query === "string" ? p.body.query : "";
      expect(query).not.toMatch(REGISTERED_STATE_LOOKUP_QUERY);
    }
  });

  it("requires --target and fails with a usage error rather than proceeding without one", async () => {
    const { code, stderr } = await runCli(["migrate-state", "INF-9001"], {});
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--target|required option/i);
  });
});

// ---------------------------------------------------------------------------
// Part B — AC2: the shared low-level request function must fail loud when the
// proxy's response carries an embedded no-op-write signal. Exercised in the
// exact context a governed write verb (`complete`, `handoff`, ...) uses it:
// proxy intent set, GraphQL response nominally successful (`data` present,
// no top-level `errors`), but `_workflowTransition.status === "failed"`
// alongside it.
// ---------------------------------------------------------------------------

describe("INF-1261 AC2 — linearGraphQL() must fail loud on an embedded _workflowTransition failure signal", () => {
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

  it("throws (does not silently return) when the mutation response carries _workflowTransition: { status: 'failed' } alongside a nominally-successful `data`", async () => {
    mockedAxios.get.mockResolvedValue({ data: {}, headers: {} });
    mockedAxios.post.mockResolvedValue({
      data: withFailedWorkflowTransition({
        data: { issueUpdate: { success: true, issue: { id: "issue-1" } } },
      }),
    });

    // The exact context `complete()` (src/semantic.ts) and `handoff()` use:
    // intent set before the write, cleared after.
    setProxyIntent("complete");

    await expect(
      linearGraphQL("mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }", { id: "issue-1", input: {} })
    ).rejects.toThrow(/did not apply|failed|no-op|not.*(persist|land|apply)/i);
  });

  it("regression: simulated no-op write on complete surfaces as loud CLI failure, not silent success", async () => {
    mockedAxios.get.mockResolvedValue({ data: {}, headers: {} });
    mockedAxios.post.mockResolvedValue({
      data: withFailedWorkflowTransition(
        { data: { issueUpdate: { success: true, issue: { id: "issue-1" } } } },
        "target state unchanged — write treated as no-op by the proxy"
      ),
    });
    setProxyIntent("complete");

    // Today this resolves with { issueUpdate: {...} } — the embedded failure
    // signal is dropped by the `{ data?, errors? }`-only response typing, so
    // the caller (and ultimately the CLI's `complete` command) sees success.
    // This assertion is what should fail today and pass once fixed.
    await expect(
      linearGraphQL("mutation { issueUpdate(id: \"issue-1\", input: {}) { success issue { id } } }")
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Part C — AC2 (CLI-level) + AC3: the new recovery verbs must fail loud at
// the CLI process boundary too (non-zero exit, no reported success) when the
// proxy signals a no-op write, and must drive a stranded ticket to the
// target state end-to-end when the write is verified-applied.
// ---------------------------------------------------------------------------

describe("INF-1261 AC2/AC3 — `rewind`/`migrate-state` fail loud at the CLI boundary on an unapplied write", () => {
  let proxy: MockProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it("rewind: a mutation response with _workflowTransition: { status: 'failed' } produces a non-zero exit and no success report", async () => {
    proxy = await startMockProxy((req) => {
      const query: string = typeof req.body?.query === "string" ? req.body.query : "";
      const body = query.includes("issueUpdate") ? issueUpdateBody("In Review") : issueDetailBody("In Review");
      return { body: withFailedWorkflowTransition(body, "rewind did not apply — target state unchanged") };
    });

    const { code, stdout, stderr } = await runCli(["rewind", "INF-9001", "--target", "In Review"], {
      LINEAR_PROXY_URL: proxy.url,
    });

    // Today: the CLI has no `rewind` command at all, so this already fails
    // (non-zero exit) — but for the wrong reason ("unknown command"), not
    // because of fail-loud verification logic. Once `rewind` exists, this
    // guards against it reporting success on an unapplied write.
    expect(code).not.toBe(0);
    expect(stdout).not.toMatch(/"identifier"\s*:\s*"INF-9001"/);
    expect(stderr).toMatch(/fail|did not apply|not applied|no-?op/i);
  });

  it("migrate-state: a mutation response with _workflowTransition: { status: 'failed' } produces a non-zero exit and no success report", async () => {
    proxy = await startMockProxy((req) => {
      const query: string = typeof req.body?.query === "string" ? req.body.query : "";
      const body = query.includes("issueUpdate") ? issueUpdateBody("Backlog") : issueDetailBody("Backlog");
      return { body: withFailedWorkflowTransition(body, "migrate-state did not apply — target state unchanged") };
    });

    const { code, stdout, stderr } = await runCli(["migrate-state", "INF-9001", "--target", "Backlog"], {
      LINEAR_PROXY_URL: proxy.url,
    });

    expect(code).not.toBe(0);
    expect(stdout).not.toMatch(/"identifier"\s*:\s*"INF-9001"/);
    expect(stderr).toMatch(/fail|did not apply|not applied|no-?op/i);
  });
});

describe("INF-1261 AC3 — `rewind`/`migrate-state` drive a stranded ticket to the target state end-to-end", () => {
  let proxy: MockProxy | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  it("rewind: a verified-applied write reports the ticket at the requested --target state", async () => {
    // The "stranded" ticket: current state ("Blocked") never appears in any
    // response — only the target the proxy resolved to after rewind applies.
    proxy = await startMockProxy((req) => {
      const query: string = typeof req.body?.query === "string" ? req.body.query : "";
      return { body: query.includes("issueUpdate") ? issueUpdateBody("In Review") : issueDetailBody("In Review") };
    });

    const { code, stdout, stderr } = await runCli(["rewind", "INF-9001", "--target", "In Review"], {
      LINEAR_PROXY_URL: proxy.url,
    });

    expect(stderr).not.toMatch(/unknown command|unknown option/i);
    expect(code).toBe(0);
    expect(stdout).toMatch(/In Review/);
  });

  it("migrate-state: a verified-applied write reports the ticket at the requested --target state", async () => {
    proxy = await startMockProxy((req) => {
      const query: string = typeof req.body?.query === "string" ? req.body.query : "";
      return { body: query.includes("issueUpdate") ? issueUpdateBody("Backlog") : issueDetailBody("Backlog") };
    });

    const { code, stdout, stderr } = await runCli(["migrate-state", "INF-9001", "--target", "Backlog"], {
      LINEAR_PROXY_URL: proxy.url,
    });

    expect(stderr).not.toMatch(/unknown command|unknown option/i);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Backlog/);
  });
});
