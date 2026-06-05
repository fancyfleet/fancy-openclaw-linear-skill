import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import axios from "axios";

import { ensureApiKey } from "./auth";

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
};

/**
 * Only Linear-owned hosts are allowed. The Authorization header carries the
 * agent's Linear token, so fetching an arbitrary URL would leak it to whatever
 * host the caller passed. Restricting to *.linear.app keeps the token in-family.
 */
function assertLinearHost(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-https URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "linear.app" && !host.endsWith(".linear.app")) {
    throw new Error(
      `Refusing to send the Linear token to a non-Linear host (${host}). ` +
      `fetch-image only accepts uploads.linear.app / *.linear.app URLs.`
    );
  }
  return parsed;
}

function resolveOutputPath(url: URL, contentType: string, out?: string): string {
  if (out) return out;
  const base = path.basename(url.pathname) || "linear-image";
  const hasExt = path.extname(base).length > 0;
  const ext = hasExt ? "" : (EXT_BY_CONTENT_TYPE[contentType.split(";")[0].trim()] ?? "");
  return path.join(os.tmpdir(), `${base}${ext}`);
}

export async function fetchImage(
  url: string,
  out?: string
): Promise<{ url: string; savedPath: string; contentType: string; bytes: number }> {
  const parsed = assertLinearHost(url);
  const apiKey = ensureApiKey();

  let response;
  try {
    response = await axios.get<ArrayBuffer>(parsed.toString(), {
      headers: { Authorization: apiKey },
      responseType: "arraybuffer",
      maxRedirects: 5,
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      if (error.response.status === 401) {
        throw new Error(
          "Linear returned 401 fetching the image. The token is missing or invalid for this upload."
        );
      }
      throw new Error(
        `Linear returned HTTP ${error.response.status} fetching the image: ${error.response.statusText}`
      );
    }
    throw error;
  }

  const contentType = String(response.headers["content-type"] ?? "application/octet-stream");
  const buffer = Buffer.from(response.data);
  const savedPath = resolveOutputPath(parsed, contentType, out);
  await fs.writeFile(savedPath, buffer);

  return { url, savedPath, contentType, bytes: buffer.byteLength };
}
