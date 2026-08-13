/**
 * INF-1508 — `linear edit` gains --description-file + normalizeCliDescription guard.
 *
 * Option A: --description-file mirrors `linear create`, letting agents pass
 *           Markdown/multiline descriptions from a file instead of inlining
 *           into a shell-quoted --description flag.
 * Option B: normalizeCliDescription on the inline --description path catches
 *           literal \n sequences (the JSON.stringify foot-gun) before they
 *           reach the Linear API and wedge downstream parsers.
 *
 * Test strategy: drive the REAL BUILT CLI (`dist/index.js`) as a subprocess
 * against a local mock proxy server, asserting on the raw outgoing mutation
 * the proxy observed. This is the same black-box boundary used by
 * inf-1261-cli-recovery-verbs-fail-loud.test.ts.
 *
 * Requires `npm run build` first.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import axios from "axios";

jest.mock("axios");
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  ensureApiKey: jest.fn(() => "test-api-key"),
  resolveAgentName: jest.fn(() => ({ name: "igor", sources: [] })),
}));

const mockedAxios = axios as unknown as jest.Mock;

const repoRoot = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Mock proxy harness (same shape as inf-1261 suite).
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

async function startMockProxy(): Promise<MockProxy> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed: any = body;
      const ct = req.headers["content-type"] || "";
      if (ct.includes("json") && body) {
        try { parsed = JSON.parse(body); } catch { /* leave as string */ }
      }
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: parsed });
      // Minimal successful response for any GraphQL mutation/query.
      if (req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          data: {
            issueUpdate: { success: true, issue: { id: "issue-uuid-1" } },
            issue: {
              id: "issue-uuid-1",
              identifier: "INF-1508",
              title: "Test",
              description: "test",
              url: "https://linear.app/test/INF-1508/test",
              createdAt: "2026-08-13T00:00:00Z",
              updatedAt: "2026-08-13T00:00:00Z",
              priority: 0,
              state: { id: "s1", name: "Todo", type: "unstarted" },
              assignee: null,
              delegate: null,
              team: { id: "t1", key: "INF", name: "Infra" },
              project: null,
              projectMilestone: null,
              labels: { nodes: [] },
              relations: { nodes: [] },
              comments: { nodes: [] },
              children: { nodes: [] },
            },
          },
        }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// CLI subprocess helper.
// ---------------------------------------------------------------------------

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn("node", [path.join(repoRoot, "dist", "index.js"), ...args], {
      env: { ...process.env, ...env },
      cwd: repoRoot,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("INF-1508: linear edit --description-file + normalization", () => {
  let proxy: MockProxy;

  beforeEach(async () => {
    proxy = await startMockProxy();
    mockedAxios.mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(async () => {
    await proxy.close();
    jest.restoreAllMocks();
  });

  const env = (proxyUrl: string) => ({
    LINEAR_API_KEY: "test-api-key",
    LINEAR_PROXY_URL: proxyUrl,
    LINEAR_AGENT_NAME: "igor",
  });

  it("AC1: --description-file reads multiline Markdown from file and sends it verbatim", async () => {
    const tmpFile = path.join(os.tmpdir(), `inf1508-desc-${Date.now()}.md`);
    const markdown = "## structured\n\n- item 1\n- item 2\n\nEnd.";
    await fs.writeFile(tmpFile, markdown, "utf8");

    try {
      const result = await runCli(
        ["edit", "INF-1508", "--description-file", tmpFile],
        env(proxy.url),
      );

      expect(result.code).toBe(0);
      // Find the issueUpdate mutation request.
      const mutationReq = proxy.requests.find(
        (r) => r.body?.variables?.input?.description !== undefined,
      );
      expect(mutationReq).toBeDefined();
      expect(mutationReq!.body.variables.input.description).toBe(markdown);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it("AC2: inline --description with literal \\n is normalized to real newlines", async () => {
    const result = await runCli(
      ["edit", "INF-1508", "--description", "## structured\\n\\nBody text"],
      env(proxy.url),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Warning: converted literal");

    const mutationReq = proxy.requests.find(
      (r) => r.body?.variables?.input?.description !== undefined,
    );
    expect(mutationReq).toBeDefined();
    expect(mutationReq!.body.variables.input.description).toBe("## structured\n\nBody text");
  });

  it("AC3: --description and --description-file are mutually exclusive", async () => {
    const tmpFile = path.join(os.tmpdir(), `inf1508-both-${Date.now()}.md`);
    await fs.writeFile(tmpFile, "content", "utf8");

    try {
      const result = await runCli(
        ["edit", "INF-1508", "--description", "inline", "--description-file", tmpFile],
        env(proxy.url),
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("not both");
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it("AC4: --title alone still works (no description required)", async () => {
    const result = await runCli(
      ["edit", "INF-1508", "--title", "New Title"],
      env(proxy.url),
    );

    expect(result.code).toBe(0);
    const mutationReq = proxy.requests.find(
      (r) => r.body?.variables?.input?.title !== undefined,
    );
    expect(mutationReq).toBeDefined();
    expect(mutationReq!.body.variables.input.title).toBe("New Title");
  });

  it("AC5: no flags throws with updated error message", async () => {
    const result = await runCli(["edit", "INF-1508"], env(proxy.url));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--description-file");
  });
});
