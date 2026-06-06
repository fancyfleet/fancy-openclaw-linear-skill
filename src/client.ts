import axios from "axios";

import { ensureApiKey } from "./auth";
import { debugDump, isDebugMode } from "./debug";

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Returns the GraphQL endpoint to use. When LINEAR_PROXY_URL is set, all
 * requests route through the connector proxy (Phase 0B, design.md §4.6)
 * instead of hitting api.linear.app directly. The proxy is transparent in
 * v0; future phases add per-step instruction injection and command validation.
 */
function resolveApiUrl(): string {
  return process.env.LINEAR_PROXY_URL ?? LINEAR_API_URL;
}

/**
 * Current semantic intent, set by the active semantic command before it issues
 * any GraphQL calls. The proxy reads this to enforce per-command rules
 * (Phase 2, design.md §11). Cleared by the command after completion.
 */
let _proxyIntent: string | undefined;

/**
 * Set the active semantic intent for the duration of a command.
 * Pass `undefined` to clear. Only affects proxied requests;
 * no-op when LINEAR_PROXY_URL is unset.
 */
export function setProxyIntent(intent: string | undefined): void {
  _proxyIntent = intent;
}

/**
 * Extra headers to attach when routing through the proxy so it can identify
 * the calling agent for logging and enforcement (Phase 2, design.md §11).
 */
function proxyHeaders(): Record<string, string> {
  const proxyUrl = process.env.LINEAR_PROXY_URL;
  if (!proxyUrl) return {};
  const agentId =
    process.env.OPENCLAW_MCP_AGENT_ID ??
    process.env.OPENCLAW_AGENT_NAME ??
    "unknown";
  const headers: Record<string, string> = { "X-Openclaw-Agent": agentId };
  if (_proxyIntent) headers["X-Openclaw-Linear-Intent"] = _proxyIntent;
  return headers;
}

export interface GraphQLErrorDetail {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

interface LinearGraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorDetail[];
}

interface HintRule {
  test: (msg: string) => boolean;
  hint: string;
}

const HINT_RULES: HintRule[] = [
  {
    test: (msg) => /self.?reference|cannot reference/i.test(msg),
    hint: "Comment body contains a bare issue identifier that references the issue itself. Replace hyphens with em-dashes (—) or spell out the ID.",
  },
  {
    test: (msg) => /too long|exceeds.*length|max.*length/i.test(msg),
    hint: "Comment body exceeds the maximum length. Split into multiple comments or shorten.",
  },
  {
    test: (msg) => /team/.test(msg) && /label/i.test(msg),
    hint: "Label belongs to a different team than the issue. Use a label from the same team, or check the team prefix.",
  },
];

function resolveHint(message: string): string | undefined {
  for (const rule of HINT_RULES) {
    if (rule.test(message)) return rule.hint;
  }
  if (/Argument Validation Error/i.test(message)) {
    return "A field failed validation. Re-run with --debug to see the raw GraphQL error details.";
  }
  return undefined;
}

function enrichMessage(errors: GraphQLErrorDetail[]): string {
  const parts: string[] = [];

  for (const err of errors) {
    const fieldPath = err.path?.join(".");
    const hint = resolveHint(err.message);
    const userMsg = err.extensions?.userPresentableMessage;

    parts.push(err.message);

    if (fieldPath) {
      parts.push(`  ↳ field: ${fieldPath}`);
    }

    // Surface the API's own validation details when available
    if (userMsg && typeof userMsg === "string" && userMsg !== err.message) {
      parts.push(`  ↳ detail: ${userMsg}`);
    }

    if (hint) {
      parts.push(`  ↳ hint: ${hint}`);
    }
  }

  return parts.join("\n");
}

export class LinearApiError extends Error {
  code?: string;
  details?: GraphQLErrorDetail[];

  constructor(message: string, code?: string, details?: GraphQLErrorDetail[]) {
    super(message);
    this.name = "LinearApiError";
    this.code = code;
    this.details = details;
  }
}

export async function linearGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const apiKey = ensureApiKey();
  const apiUrl = resolveApiUrl();
  let response;
  try {
    response = await axios.post<LinearGraphQLResponse<T>>(
      apiUrl,
      { query, variables },
      {
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
          ...proxyHeaders(),
        },
      }
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const errors = (error.response.data?.errors ?? []) as GraphQLErrorDetail[];
        if (error.response.status === 401) {
          throw new LinearApiError("Unauthorized", "UNAUTHORIZED");
        }
        debugDump("HTTP error response", error.response.data);
        const message = errors.length
          ? enrichMessage(errors)
          : `Linear API returned HTTP ${error.response.status}: ${error.response.statusText}`;
        throw new LinearApiError(message, `HTTP_${error.response.status}`, errors);
      }
      throw new LinearApiError(
        `Network request to Linear API failed: ${error.message}. Check your internet connection and that api.linear.app is reachable.`,
        "NETWORK_ERROR"
      );
    }
    throw error;
  }

  if (response.data.errors?.length) {
    debugDump("GraphQL errors", response.data.errors);
    throw new LinearApiError(
      enrichMessage(response.data.errors),
      "GRAPHQL_ERROR",
      response.data.errors
    );
  }

  if (!response.data.data) {
    throw new LinearApiError("Linear API returned no data.", "NO_DATA");
  }

  return response.data.data;
}

export async function putPresignedFile(
  url: string,
  content: Buffer,
  contentType: string,
  extraHeaders?: Array<{ key: string; value: string }>
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(content.byteLength),
  };

  for (const header of extraHeaders ?? []) {
    headers[header.key] = header.value;
  }

  await axios.put(url, content, {
    headers,
  });
}
