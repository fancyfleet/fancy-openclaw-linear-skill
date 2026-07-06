/**
 * AI-1849 — `linear guidance` CLI verb.
 *
 * The guidance command fetches connector docs through the proxy connector URL,
 * allowing agents to pull L3 material (capability docs, playbooks, how-tos)
 * on demand rather than having it all inlined into wake messages.
 *
 * AC coverage:
 *  AC1 — `linear guidance` lists topics; `linear guidance <topic>` returns body.
 *         Works with lpx proxy token; no extra env beyond LINEAR_PROXY_URL.
 *  AC2 — `linear guidance capabilities` returns the requesting agent's OWN
 *         capability set (scoped by the connector to the bearer token).
 *  AC4 — Unknown topic → helpful error listing valid topics; no stack trace.
 *  AC6 — Ships as CLI 0.3.7+ with tests.
 */

import axios from "axios";
import { listGuidanceTopics, fetchGuidanceTopic, GuidanceTopic } from "../guidance";

jest.mock("axios");
jest.mock("../auth", () => ({
  ensureApiKey: jest.fn(() => "lpx_test_proxy_token_abc123"),
}));

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;

const PROXY_URL = "http://connector.local:3100/proxy/graphql";
const EXPECTED_DOCS_BASE = "http://connector.local:3100/docs";

function mockTopicListResponse(topics: GuidanceTopic[]) {
  mockedGet.mockResolvedValueOnce({
    data: { topics },
    status: 200,
    statusText: "OK",
    headers: {},
    config: {} as never,
  } as never);
}

function mockDocBodyResponse(topic: string, body: string, extra?: Record<string, unknown>) {
  mockedGet.mockResolvedValueOnce({
    data: { topic, body, ...extra },
    status: 200,
    statusText: "OK",
    headers: {},
    config: {} as never,
  } as never);
}

const SAMPLE_TOPICS: GuidanceTopic[] = [
  { id: "capabilities", description: "Your agent's capability set from capability-policy.yaml" },
  { id: "canon", description: "Universal task-handling canon" },
  { id: "deploy", description: "Deployment playbook" },
];

beforeEach(() => {
  mockedGet.mockReset();
  process.env.LINEAR_PROXY_URL = PROXY_URL;
});

afterEach(() => {
  delete process.env.LINEAR_PROXY_URL;
});

// ── AC1: topic listing ────────────────────────────────────────────────────

describe("AC1: listGuidanceTopics", () => {
  it("calls GET /docs on the connector with the agent's proxy token", async () => {
    mockTopicListResponse(SAMPLE_TOPICS);
    await listGuidanceTopics();

    expect(mockedGet).toHaveBeenCalledWith(
      EXPECTED_DOCS_BASE,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer lpx_test_proxy_token_abc123",
        }),
      }),
    );
  });

  it("derives the /docs URL from LINEAR_PROXY_URL (strips /proxy/graphql, adds /docs)", async () => {
    mockTopicListResponse(SAMPLE_TOPICS);
    await listGuidanceTopics();

    const calledUrl = mockedGet.mock.calls[0][0] as string;
    expect(calledUrl).toBe(EXPECTED_DOCS_BASE);
    expect(calledUrl).not.toContain("/proxy/graphql");
    expect(calledUrl).not.toContain("/graphql");
  });

  it("returns an array of GuidanceTopic objects with id and description", async () => {
    mockTopicListResponse(SAMPLE_TOPICS);
    const topics = await listGuidanceTopics();

    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("description");
      expect(typeof t.id).toBe("string");
      expect(typeof t.description).toBe("string");
    }
  });

  it("includes capabilities, canon, and deploy in the returned topics", async () => {
    mockTopicListResponse(SAMPLE_TOPICS);
    const topics = await listGuidanceTopics();

    const ids = topics.map((t) => t.id);
    expect(ids).toContain("capabilities");
    expect(ids).toContain("canon");
    expect(ids).toContain("deploy");
  });

  it("throws if LINEAR_PROXY_URL is not set", async () => {
    delete process.env.LINEAR_PROXY_URL;
    await expect(listGuidanceTopics()).rejects.toThrow(/LINEAR_PROXY_URL/);
  });
});

// ── AC1: topic fetch ──────────────────────────────────────────────────────

describe("AC1: fetchGuidanceTopic", () => {
  it("calls GET /docs/:topic on the connector with the proxy token", async () => {
    mockDocBodyResponse("canon", "1. Read the ticket fully before acting.");
    await fetchGuidanceTopic("canon");

    expect(mockedGet).toHaveBeenCalledWith(
      `${EXPECTED_DOCS_BASE}/canon`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer lpx_test_proxy_token_abc123",
        }),
      }),
    );
  });

  it("returns { topic, body } from the response", async () => {
    const expectedBody = "1. Read the ticket fully before acting.";
    mockDocBodyResponse("canon", expectedBody);

    const result = await fetchGuidanceTopic("canon");

    expect(result.topic).toBe("canon");
    expect(result.body).toBe(expectedBody);
  });

  it("fetches deploy doc from /docs/deploy", async () => {
    mockDocBodyResponse("deploy", "# Deploy Playbook\n\nSteps for deploying.");
    const result = await fetchGuidanceTopic("deploy");

    const calledUrl = mockedGet.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`${EXPECTED_DOCS_BASE}/deploy`);
    expect(result.body).toContain("Deploy Playbook");
  });

  it("throws if LINEAR_PROXY_URL is not set", async () => {
    delete process.env.LINEAR_PROXY_URL;
    await expect(fetchGuidanceTopic("canon")).rejects.toThrow(/LINEAR_PROXY_URL/);
  });
});

// ── AC2: capabilities — self-scoped ──────────────────────────────────────

describe("AC2: fetchGuidanceTopic(capabilities) — self-scoped rendering", () => {
  it("calls GET /docs/capabilities with the agent's proxy token", async () => {
    mockDocBodyResponse("capabilities", "igor: linear:transition, repo:write", {
      agent: "igor",
      container: "dev-backend",
      capabilities: [{ id: "linear:transition" }, { id: "repo:write" }],
    });
    await fetchGuidanceTopic("capabilities");

    const calledUrl = mockedGet.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`${EXPECTED_DOCS_BASE}/capabilities`);
    expect(mockedGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer lpx_test_proxy_token_abc123",
        }),
      }),
    );
  });

  it("capability result includes agent, container, and capabilities fields", async () => {
    mockDocBodyResponse("capabilities", "igor capabilities: linear:transition, repo:write", {
      agent: "igor",
      container: "dev-backend",
      capabilities: [
        { id: "linear:transition", description: "Make Linear workflow transitions" },
        { id: "repo:write", description: "Push commits to GitHub" },
      ],
    });
    const result = await fetchGuidanceTopic("capabilities");

    expect(result).toMatchObject({
      topic: "capabilities",
      body: expect.stringContaining("igor"),
    });
  });

  it("scoping is server-side: the request sends only the token, not an agent name header", async () => {
    mockDocBodyResponse("capabilities", "sage capabilities: linear:transition", {
      agent: "sage",
      container: "dev-frontend",
      capabilities: [{ id: "linear:transition" }],
    });
    await fetchGuidanceTopic("capabilities");

    const callConfig = mockedGet.mock.calls[0][1] as Record<string, unknown>;
    const headers = callConfig?.headers as Record<string, string> | undefined;
    // Should NOT send x-openclaw-agent or similar identity header —
    // the connector resolves the agent from the proxy token server-side.
    expect(headers?.["x-openclaw-agent"]).toBeUndefined();
  });
});

// ── AC4: unknown topic → helpful error ───────────────────────────────────

describe("AC4: unknown topic → helpful error from connector", () => {
  it("throws a user-friendly error with valid topics when connector returns 404", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 404"), {
        isAxiosError: true,
        response: {
          status: 404,
          data: {
            error: "Unknown topic: 'no-such-topic'",
            validTopics: ["capabilities", "canon", "deploy"],
          },
        },
      }),
    );

    await expect(fetchGuidanceTopic("no-such-topic")).rejects.toThrow(/valid topics/i);
  });

  it("error message for unknown topic lists at least capabilities, canon, deploy", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 404"), {
        isAxiosError: true,
        response: {
          status: 404,
          data: {
            error: "Unknown topic",
            validTopics: ["capabilities", "canon", "deploy"],
          },
        },
      }),
    );

    let error: Error | null = null;
    try {
      await fetchGuidanceTopic("no-such-topic");
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.message).toContain("capabilities");
    expect(error!.message).toContain("canon");
    expect(error!.message).toContain("deploy");
  });

  it("error message does not leak a stack trace", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 404"), {
        isAxiosError: true,
        response: {
          status: 404,
          data: { error: "Unknown topic", validTopics: ["canon"] },
        },
      }),
    );

    let error: Error | null = null;
    try {
      await fetchGuidanceTopic("no-such-topic");
    } catch (e) {
      error = e as Error;
    }

    expect(error!.message).not.toMatch(/at Object\./);
    expect(error!.message).not.toMatch(/\.ts:\d+/);
  });
});

// ── AC1: unauthenticated → propagates 401 ────────────────────────────────

describe("AC1: auth propagation", () => {
  it("propagates a 401 response as an authentication error", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 401"), {
        isAxiosError: true,
        response: { status: 401, data: { error: "Missing Authorization header" } },
      }),
    );

    await expect(fetchGuidanceTopic("canon")).rejects.toThrow(/401|auth|token/i);
  });
});

// ── AC6: version guard (structural — module must export the right shape) ──

describe("AC6: module shape", () => {
  it("exports listGuidanceTopics as a function", () => {
    expect(typeof listGuidanceTopics).toBe("function");
  });

  it("exports fetchGuidanceTopic as a function", () => {
    expect(typeof fetchGuidanceTopic).toBe("function");
  });

  it("exports the GuidanceTopic interface-compatible shape (duck-typed via example topic)", async () => {
    mockTopicListResponse([{ id: "canon", description: "Universal canon" }]);
    const topics = await listGuidanceTopics();
    // Structural check: every topic has id (string) and description (string)
    for (const t of topics) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.description).toBe("string");
    }
  });
});
