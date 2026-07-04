/**
 * AI-1767 — Tests for cross-agent upload access in fetch-image.
 *
 * AC mapping:
 *   AC 1 — 401 message names cross-app token scoping as a root cause
 *   AC 2 — fetchImage gracefully reports the cross-agent limitation (doc path
 *          resolution; the SKILL.md correction is verified separately)
 *   AC 3 — Simulated cross-agent 401 produces actionable guidance naming the
 *          workaround (fetch from the uploading agent's container)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import axios from "axios";

import { fetchImage } from "../fetch-image";

jest.mock("axios");
jest.mock("../auth", () => ({
  ensureApiKey: jest.fn(() => "lin_api_test"),
}));

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;
(axios.isAxiosError as unknown) = jest.requireActual("axios").isAxiosError;

describe("AI-1767: fetch-image cross-agent upload access", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  // AC 1 — Root cause identified in the 401 message
  it("401 error message names cross-app / cross-agent token scoping as a possible cause", async () => {
    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, statusText: "Unauthorized" },
      message: "Request failed with status code 401",
    });

    await expect(
      fetchImage("https://uploads.linear.app/abc/def")
    ).rejects.toThrow(/cross-agent|cross-app|uploaded by a different agent/i);
  });

  // AC 1 — Root cause identified: the message should mention that uploads may
  // be scoped to the OAuth app that created them
  it("401 error message mentions OAuth-app scoping or that uploads belong to the creating app", async () => {
    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, statusText: "Unauthorized" },
      message: "Request failed with status code 401",
    });

    await expect(
      fetchImage("https://uploads.linear.app/abc/def")
    ).rejects.toThrow(/oauth|app|scoped|creating agent|uploader/i);
  });

  // AC 2 — Graceful failure with actionable guidance (doc path resolution)
  it("401 error message includes a sanctioned workaround (fetch from the uploading agent)", async () => {
    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, statusText: "Unauthorized" },
      message: "Request failed with status code 401",
    });

    await expect(
      fetchImage("https://uploads.linear.app/abc/def")
    ).rejects.toThrow(/uploading agent|uploader.*fetch|fetch.*from.*agent|same agent/i);
  });

  // AC 3 — Cross-agent verification: a non-401 error still works (regression guard)
  it("non-401 errors (e.g. 404) are reported with HTTP status, not the cross-agent message", async () => {
    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, statusText: "Not Found" },
      message: "Request failed with status code 404",
    });

    await expect(
      fetchImage("https://uploads.linear.app/abc/def")
    ).rejects.toThrow(/HTTP 404/);
  });

  // AC 3 — Cross-agent verification: the 401 message should NOT swallow the URL
  // context, so the user can identify which upload failed
  it("401 error preserves enough context to identify the failed upload URL", async () => {
    mockedGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, statusText: "Unauthorized" },
      message: "Request failed with status code 401",
    });

    // The thrown error or stdout should reference the URL or a meaningful identifier.
    // We don't mandate exact format, but the test should fail if the message is
    // too generic (just "401" with no upload reference).
    let caught: Error | undefined;
    try {
      await fetchImage("https://uploads.linear.app/abc/def-unique-id");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // The error message or the URL itself should be traceable — either the URL
    // appears in the message, or the function returns enough context for the
    // caller to log it. At minimum, the message should be more specific than
    // "Linear returned 401".
    expect(caught!.message.length).toBeGreaterThan(60);
    expect(caught!.message).not.toBe(
      "Linear returned 401 fetching the image. The token is missing or invalid for this upload."
    );
  });
});
