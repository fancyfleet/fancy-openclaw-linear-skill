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

/** The release that introduced the header — the floor pkg.version must never fall below. */
const HEADER_EMITTING_RELEASE = "0.3.8";

/** Numeric semver compare on the release triple; returns <0, 0, or >0. */
function compareSemver(a: string, b: string): number {
  const triple = (v: string) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [triple(a), triple(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

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
    // The version must be a real semver at or above the release that introduced the
    // header, which is the shape the connector's floor compares against. Asserting an
    // exact literal here instead made every bump fail CI until the test was hand-edited
    // to match (f8046ee did exactly that), so the pin is a floor, not an equality.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(compareSemver(pkg.version, HEADER_EMITTING_RELEASE)).toBeGreaterThanOrEqual(0);
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
