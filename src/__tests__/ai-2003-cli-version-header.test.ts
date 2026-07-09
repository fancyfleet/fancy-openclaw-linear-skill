/**
 * AI-2003 / AI-1397: the proxy client must emit the X-Openclaw-Linear-Cli-Version
 * header on outgoing GraphQL requests when routing through the connector proxy.
 *
 * The connector's version floor (linear-webhook-fancymatt proxy.ts) reads
 * `x-openclaw-linear-cli-version` and rejects workflow mutations from CLIs below
 * the floor. Until a deployed CLI actually sends this header the floor is inert
 * and the connector runs with PROXY_ALLOW_MISSING_CLI_VERSION=1 (fail-open).
 *
 * This test locks in that a proxied request carries the header with the CLI's
 * real package version, and that a direct (non-proxy) request does NOT add proxy
 * headers.
 */

import axios from "axios";
import { linearGraphQL } from "../client";
import pkg from "../../package.json";

jest.mock("axios");

jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  ensureApiKey: jest.fn(() => "test-api-key"),
  resolveAgentName: jest.fn(() => ({ name: "igor", sources: [] })),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function lastPostHeaders(): Record<string, string> {
  const call = mockedAxios.post.mock.calls[mockedAxios.post.mock.calls.length - 1];
  return (call[2] as { headers: Record<string, string> }).headers;
}

describe("AI-2003 — CLI version header on proxied requests", () => {
  const OLD_ENV = process.env.LINEAR_PROXY_URL;

  beforeEach(() => {
    mockedAxios.post.mockReset();
    (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn(() => false);
    mockedAxios.post.mockResolvedValue({ data: { data: { ok: true } } });
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.LINEAR_PROXY_URL;
    else process.env.LINEAR_PROXY_URL = OLD_ENV;
  });

  it("emits X-Openclaw-Linear-Cli-Version carrying the real package version when proxied", async () => {
    process.env.LINEAR_PROXY_URL = "https://proxy.example.test/graphql";

    await linearGraphQL("query { viewer { id } }");

    const headers = lastPostHeaders();
    expect(headers["X-Openclaw-Linear-Cli-Version"]).toBe(pkg.version);
    // sanity: the version we ship the header with is the bumped 0.3.8 release
    expect(pkg.version).toBe("0.3.8");
    expect(headers["X-Openclaw-Agent"]).toBe("igor");
  });

  it("does NOT add proxy headers on a direct (non-proxy) request", async () => {
    delete process.env.LINEAR_PROXY_URL;

    await linearGraphQL("query { viewer { id } }");

    const headers = lastPostHeaders();
    expect(headers["X-Openclaw-Linear-Cli-Version"]).toBeUndefined();
    expect(headers["X-Openclaw-Agent"]).toBeUndefined();
  });
});
