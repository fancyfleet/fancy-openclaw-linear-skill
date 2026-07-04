/**
 * AI-1767 — Tests for proxy-aware fetch-image.
 *
 * Root cause (confirmed during AC validation): agent containers hold `lpx_`
 * proxy tokens, not real Linear OAuth tokens. uploads.linear.app rejects proxy
 * tokens with 401. The fix routes fetch-image through the connector proxy when
 * LINEAR_PROXY_URL is set, so the connector can swap in real credentials.
 *
 * AC mapping:
 *   AC 1 — Root cause identified: proxy token sent directly to uploads.linear.app
 *   AC 2 — fetch-image routes through the proxy when LINEAR_PROXY_URL is set
 *   AC 3 — Same-agent and cross-agent fetches both succeed via the proxy
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import axios from "axios";

import { fetchImage } from "../fetch-image";

jest.mock("axios");
jest.mock("../auth", () => ({
  ensureApiKey: jest.fn(() => "lpx_test_proxy_token"),
}));

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;
(axios.isAxiosError as unknown) = jest.requireActual("axios").isAxiosError;

describe("AI-1767: fetch-image proxy-aware routing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockedGet.mockReset();
    delete process.env.LINEAR_PROXY_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // AC 1 — When proxy is set, fetch goes through the connector, not directly
  it("routes through the proxy when LINEAR_PROXY_URL is set", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    const body = Buffer.from("fake-png-bytes");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/png" },
    } as never);
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue();

    await fetchImage("https://uploads.linear.app/abc/def");

    // Must hit the proxy upload endpoint, NOT uploads.linear.app directly
    const calledUrl = mockedGet.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/proxy/upload");
    expect(calledUrl).toContain(encodeURIComponent("https://uploads.linear.app/abc/def"));
    expect(calledUrl).not.toMatch(/^https:\/\/uploads\.linear\.app\//);

    writeSpy.mockRestore();
  });

  // AC 2 — Proxy URL is derived correctly from LINEAR_PROXY_URL
  it("correctly derives the upload proxy URL from the graphql proxy URL", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    const body = Buffer.from("data");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/png" },
    } as never);
    jest.spyOn(fs, "writeFile").mockResolvedValue();

    await fetchImage("https://uploads.linear.app/team/img-123");

    const calledUrl = mockedGet.mock.calls[0][0] as string;
    // Base should be http://172.32.0.1:3100/proxy/upload with url= query param
    expect(calledUrl).toMatch(/^http:\/\/172\.32\.0\.1:3100\/proxy\/upload\?url=/);
  });

  // AC 2 — When NO proxy is set, fetch goes directly (backward compat)
  it("fetches directly from uploads.linear.app when LINEAR_PROXY_URL is not set", async () => {
    const body = Buffer.from("direct-bytes");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/jpeg" },
    } as never);
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue();

    await fetchImage("https://uploads.linear.app/abc/def");

    const calledUrl = mockedGet.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://uploads.linear.app/abc/def");

    // The auth header should carry the token directly
    const callOptions = mockedGet.mock.calls[0][1] as Record<string, unknown>;
    expect((callOptions.headers as Record<string, string>).Authorization).toBe("lpx_test_proxy_token");

    writeSpy.mockRestore();
  });

  // AC 3 — Same-agent fetch via proxy succeeds (control test for the real root cause)
  it("same-agent fetch via proxy returns image bytes successfully", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    const body = Buffer.from("real-image-bytes-from-proxy");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/png" },
    } as never);
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue();

    const result = await fetchImage("https://uploads.linear.app/abc/my-upload");

    expect(result.bytes).toBe(body.byteLength);
    expect(result.contentType).toBe("image/png");
    expect(result.savedPath).toBe(path.join(os.tmpdir(), "my-upload.png"));
    writeSpy.mockRestore();
  });

  // AC 3 — Cross-agent fetch via proxy also succeeds (the actual bug scenario)
  it("cross-agent fetch via proxy succeeds (the original bug scenario)", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    // The proxy endpoint fetches with the real workspace token, so cross-agent
    // uploads are readable — the connector has workspace-wide credentials.
    const body = Buffer.from("cross-agent-image-bytes");
    mockedGet.mockResolvedValue({
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: { "content-type": "image/webp" },
    } as never);
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue();

    const result = await fetchImage("https://uploads.linear.app/abc/upload-by-other-agent");

    expect(result.bytes).toBe(body.byteLength);
    expect(result.contentType).toBe("image/webp");
    writeSpy.mockRestore();
  });

  // AC 1 — 401 error message when using proxy indicates proxy token issue
  it("401 via proxy gives a proxy-token-aware error message", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, statusText: "Unauthorized" },
      message: "Request failed with status code 401",
    });

    await expect(
      fetchImage("https://uploads.linear.app/abc/def")
    ).rejects.toThrow(/proxy/i);
  });

  // Regression: non-401 errors still report HTTP status
  it("non-401 errors (e.g. 404) are reported with HTTP status", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, statusText: "Not Found" },
      message: "Request failed with status code 404",
    });

    await expect(
      fetchImage("https://uploads.linear.app/abc/def")
    ).rejects.toThrow(/HTTP 404/);
  });

  // Regression: non-Linear hosts are still rejected
  it("rejects non-Linear hosts before making a request", async () => {
    process.env.LINEAR_PROXY_URL = "http://172.32.0.1:3100/proxy/graphql";

    await expect(fetchImage("https://evil.com/steal")).rejects.toThrow(/non-Linear host/);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
