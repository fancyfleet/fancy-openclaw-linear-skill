import axios from "axios";

import { linearGraphQL, LinearApiError } from "../client";

jest.mock("axios");
jest.mock("../auth", () => ({
  ensureApiKey: jest.fn(() => "lin_api_test"),
  resolveAgentName: jest.fn(() => ({ name: "ai" })),
}));

const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;
// linearGraphQL uses axios.isAxiosError; keep the real implementation.
(axios.isAxiosError as unknown) = jest.requireActual("axios").isAxiosError;

function connError(code: string): Error & { isAxiosError: true; code: string; response?: undefined } {
  return Object.assign(new Error(`connect ${code}`), {
    isAxiosError: true as const,
    code,
    response: undefined,
  });
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true as const,
    code: undefined,
    response: { status, statusText: "x", data: {} },
  });
}

describe("G-15 proxy unreachable → bounded retry then idle", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    mockedPost.mockReset();
    process.env = { ...OLD_ENV };
    process.env.LINEAR_PROXY_URL = "http://localhost:3100/proxy/graphql";
    process.env.LINEAR_PROXY_MAX_ATTEMPTS = "3";
    process.env.LINEAR_PROXY_RETRY_BASE_MS = "0"; // fast tests
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("retries a refused connection a bounded number of times then throws PROXY_UNREACHABLE", async () => {
    mockedPost.mockRejectedValue(connError("ECONNREFUSED"));

    await expect(linearGraphQL("query { x }")).rejects.toMatchObject({
      code: "PROXY_UNREACHABLE",
    });
    // Bounded: exactly maxAttempts (3), NOT an unbounded spam loop.
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("recovers if the proxy comes back mid-retry", async () => {
    mockedPost
      .mockRejectedValueOnce(connError("ECONNREFUSED"))
      .mockResolvedValueOnce({ data: { data: { ok: true } } } as never);

    await expect(linearGraphQL("query { x }")).resolves.toEqual({ ok: true });
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("treats 502/503/504 from a fronting proxy as unreachable and retries", async () => {
    mockedPost.mockRejectedValue(httpError(503));

    await expect(linearGraphQL("query { x }")).rejects.toMatchObject({
      code: "PROXY_UNREACHABLE",
    });
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry deterministic HTTP 4xx errors (no spam)", async () => {
    mockedPost.mockRejectedValue(httpError(400));

    await expect(linearGraphQL("query { x }")).rejects.toBeInstanceOf(LinearApiError);
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("does NOT apply proxy-retry semantics when no proxy is configured", async () => {
    delete process.env.LINEAR_PROXY_URL;
    mockedPost.mockRejectedValue(connError("ECONNREFUSED"));

    await expect(linearGraphQL("query { x }")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    // Direct-to-api.linear.app keeps single-shot semantics.
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });
});
