/**
 * AI-1849 (Pillar 2 D2) — `linear guidance` CLI verb.
 *
 * Fetches L3 material (capability docs, playbooks, how-tos) from the connector
 * docs endpoint on demand, keyed by topic. Agents present their lpx proxy token;
 * the connector resolves the agent and scopes the response server-side.
 */

import axios from "axios";
import { ensureApiKey } from "./auth";

export interface GuidanceTopic {
  id: string;
  description: string;
}

export interface GuidanceDocResult {
  topic: string;
  body: string;
  [key: string]: unknown;
}

/**
 * Derive the /docs base URL from LINEAR_PROXY_URL.
 *
 * LINEAR_PROXY_URL is typically `http://host:port/proxy/graphql`.
 * We strip /proxy/graphql and add /docs → `http://host:port/docs`.
 */
function resolveDocsBaseUrl(): string {
  const proxyUrl = process.env.LINEAR_PROXY_URL;
  if (!proxyUrl) {
    throw new Error(
      "LINEAR_PROXY_URL is not set. Cannot reach the connector docs endpoint.",
    );
  }
  try {
    const parsed = new URL(proxyUrl);
    // Strip /proxy/graphql (or any /proxy/* path) and replace with /docs
    parsed.pathname = "/docs";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // Fallback: simple string replace
    return proxyUrl.replace(/\/proxy\/graphql$/, "/docs").replace(/\/graphql$/, "/docs");
  }
}

function authHeaders(): Record<string, string> {
  const token = ensureApiKey();
  return { Authorization: `Bearer ${token}` };
}

/**
 * List available guidance topics from the connector.
 */
export async function listGuidanceTopics(): Promise<GuidanceTopic[]> {
  const baseUrl = resolveDocsBaseUrl();
  const response = await axios.get<{ topics: GuidanceTopic[] }>(baseUrl, {
    headers: authHeaders(),
  });
  return response.data.topics;
}

/**
 * Fetch the body of a specific guidance topic from the connector.
 * Throws a user-friendly error for unknown topics or auth failures.
 */
export async function fetchGuidanceTopic(topic: string): Promise<GuidanceDocResult> {
  const baseUrl = resolveDocsBaseUrl();
  try {
    const response = await axios.get<GuidanceDocResult>(`${baseUrl}/${topic}`, {
      headers: authHeaders(),
    });
    return response.data;
  } catch (err) {
    const axiosErr = err as { isAxiosError?: boolean; response?: { status: number; data: unknown } };
    if (axiosErr.isAxiosError && axiosErr.response) {
      const status = axiosErr.response.status;
      const data = axiosErr.response.data as Record<string, unknown> | undefined;

      if (status === 401) {
        throw new Error(
          `401 auth error fetching guidance topic '${topic}'. ` +
          `Check that your proxy token is valid and LINEAR_PROXY_URL is correct.`,
        );
      }

      if (status === 404) {
        const validTopics = Array.isArray(data?.validTopics)
          ? (data.validTopics as string[]).join(", ")
          : "";
        const hint = validTopics ? ` Valid topics: ${validTopics}` : "";
        throw new Error(
          `Unknown guidance topic '${topic}'.${hint}`,
        );
      }

      throw new Error(
        `Failed to fetch guidance topic '${topic}': HTTP ${status}`,
      );
    }
    throw err as Error;
  }
}
