/**
 * P4-2 — Metric aggregation CLI: surface the ranked reason-code counts per step.
 *
 * Calls the connector's admin API (`/admin/api/observations/metrics`) and
 * prints the result as either a human-readable table or JSON (with --json).
 * Falls back gracefully when no proxy is configured or the connector is
 * unreachable.
 *
 * Design: phase-4-learning-loop-plan.md §C2, design.md §10 (macro layer).
 */

import axios from "axios";

// --- Types (mirrors connector's observation-store MetricRollup) ---

export interface MetricRow {
  workflow: string;
  step: string;
  reasonCode: string;
  count: number;
  fromBody?: string;
  exceedsThreshold: boolean;
}

export interface MetricSummary {
  totalObservations: number;
  uniqueWorkflows: number;
  uniqueSteps: number;
  stepsAboveThreshold: Array<{ workflow: string; step: string; total: number }>;
}

export interface MetricRollup {
  items: MetricRow[];
  summary: MetricSummary;
  query: Record<string, unknown>;
}

export interface MetricsOptions {
  workflow?: string;
  step?: string;
  reasonCode?: string;
  since?: string;
  until?: string;
  includeBody?: boolean;
  threshold?: number;
  json?: boolean;
}

/**
 * Resolve the connector admin base URL from the proxy URL.
 * The proxy URL is like `http://host:port/graphql`; the admin API lives
 * at `http://host:port/admin/api/...`.
 */
export function resolveAdminBaseUrl(): string | null {
  const proxyUrl = process.env.LINEAR_PROXY_URL;
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    // Strip the path (e.g. /graphql) and use /admin
    return `${parsed.protocol}//${parsed.host}/admin`;
  } catch {
    return null;
  }
}

/**
 * Fetch metric rollup from the connector's admin API.
 * Returns null if no proxy is configured or the request fails.
 */
export async function fetchMetrics(
  options: MetricsOptions
): Promise<MetricRollup | null> {
  const adminBase = resolveAdminBaseUrl();
  if (!adminBase) {
    return null;
  }

  const params: Record<string, string> = {};
  if (options.workflow) params.workflow = options.workflow;
  if (options.step) params.step = options.step;
  if (options.reasonCode) params.reasonCode = options.reasonCode;
  if (options.since) params.since = options.since;
  if (options.until) params.until = options.until;
  if (options.includeBody) params.includeBody = "true";
  if (options.threshold !== undefined && options.threshold > 0) {
    params.threshold = String(options.threshold);
  }

  const qs = new URLSearchParams(params).toString();
  const url = `${adminBase}/api/observations/metrics${qs ? `?${qs}` : ""}`;

  // The admin API uses ADMIN_SECRET via Bearer auth (same as the dashboard).
  // Prefer the dedicated env var; fall back to LINEAR_API_KEY for local dev.
  // The connector admin GET endpoints are unauthenticated (trusted-network).
  // No Authorization header needed for GET routes.
  try {
    const response = await axios.get<MetricRollup>(url, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 401) {
        process.stderr.write("Error: connector admin API returned 401 (unauthorized).\n");
      } else if (error.code === "ECONNREFUSED") {
        process.stderr.write("Error: connector is not reachable. Is the proxy running?\n");
      } else {
        process.stderr.write(
          `Error: connector admin API returned HTTP ${status ?? "unknown"}: ${error.message}\n`
        );
      }
    } else {
      process.stderr.write(`Error fetching metrics: ${error}\n`);
    }
    return null;
  }
}

/**
 * Parse a human-readable duration like "30d", "7d", "24h" into an ISO timestamp.
 * Returns the ISO string, or undefined if the input is not a recognized duration.
 */
export function parseDuration(duration: string): string | undefined {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  switch (unit) {
    case "d":
      now.setDate(now.getDate() - value);
      break;
    case "h":
      now.setHours(now.getHours() - value);
      break;
    case "m":
      now.setMinutes(now.getMinutes() - value);
      break;
  }
  return now.toISOString();
}

// --- Human-readable formatting ---

const REASON_CODE_LABELS: Record<string, string> = {
  "missing-tests": "❌ missing-tests",
  style: "🎨 style",
  "scope-creep": "📐 scope-creep",
  correctness: "🐛 correctness",
  "ac-mismatch": "🔄 ac-mismatch",
};

function formatReasonCode(code: string): string {
  return REASON_CODE_LABELS[code] ?? code;
}

export function formatMetricsHuman(rollup: MetricRollup): string {
  const lines: string[] = [];

  if (rollup.items.length === 0) {
    lines.push("No observations found.");
    return lines.join("\n");
  }

  // Group by workflow → step
  const groups = new Map<string, MetricRow[]>();
  for (const item of rollup.items) {
    const key = `${item.workflow} / ${item.step}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  // Compute column widths
  let maxReasonLen = 12; // "reason code"
  let maxCountLen = 5;   // "count"
  let maxBodyLen = 0;
  for (const item of rollup.items) {
    const label = formatReasonCode(item.reasonCode);
    if (label.length > maxReasonLen) maxReasonLen = label.length;
    const countStr = String(item.count);
    if (countStr.length > maxCountLen) maxCountLen = countStr.length;
    if (item.fromBody) {
      if (item.fromBody.length > maxBodyLen) maxBodyLen = item.fromBody.length;
    }
  }

  const hasBody = rollup.items.some((i) => i.fromBody);

  for (const [groupKey, items] of groups) {
    lines.push(`\n── ${groupKey} ──`);

    // Header
    const header = hasBody
      ? `  ${"reason code".padEnd(maxReasonLen)}  ${"count".padStart(maxCountLen)}  ${"body".padEnd(maxBodyLen)}  threshold`
      : `  ${"reason code".padEnd(maxReasonLen)}  ${"count".padStart(maxCountLen)}  threshold`;
    lines.push(header);
    lines.push(`  ${"─".repeat(maxReasonLen)}  ${"─".repeat(maxCountLen)}  ${"─".repeat(hasBody ? maxBodyLen : 9)}`);

    for (const item of items) {
      const reason = formatReasonCode(item.reasonCode).padEnd(maxReasonLen);
      const count = String(item.count).padStart(maxCountLen);
      const thresholdFlag = item.exceedsThreshold ? "⚠️  YES" : "";
      if (hasBody && item.fromBody) {
        const body = item.fromBody.padEnd(maxBodyLen);
        lines.push(`  ${reason}  ${count}  ${body}  ${thresholdFlag}`);
      } else {
        lines.push(`  ${reason}  ${count}  ${thresholdFlag}`);
      }
    }

    // Subtotal
    const subtotal = items.reduce((sum, i) => sum + i.count, 0);
    lines.push(`  ${"".padEnd(maxReasonLen)}  ${"─".repeat(maxCountLen)}`);
    lines.push(`  ${"TOTAL".padEnd(maxReasonLen)}  ${String(subtotal).padStart(maxCountLen)}`);
  }

  // Summary
  lines.push("");
  const { summary } = rollup;
  lines.push(`Summary: ${summary.totalObservations} observations across ${summary.uniqueWorkflows} workflow(s), ${summary.uniqueSteps} step(s)`);
  if (summary.stepsAboveThreshold.length > 0) {
    lines.push("Steps above threshold:");
    for (const s of summary.stepsAboveThreshold) {
      lines.push(`  ⚠️  ${s.workflow} / ${s.step}: ${s.total} observations`);
    }
  }

  return lines.join("\n");
}

/**
 * Main entry point for the `linear metrics` command.
 */
export async function runMetrics(options: MetricsOptions): Promise<void> {
  // Resolve --since if it's a duration shorthand
  let since = options.since;
  if (since && !since.includes("T") && !since.includes("-")) {
    const resolved = parseDuration(since);
    if (resolved) {
      since = resolved;
    } else {
      process.stderr.write(`Warning: --since value "${since}" is not a recognized duration (e.g. 30d, 7d, 24h). Passing as-is.\n`);
    }
  }

  const rollup = await fetchMetrics({ ...options, since });

  if (!rollup) {
    if (!process.env.LINEAR_PROXY_URL) {
      process.stderr.write("No proxy configured (LINEAR_PROXY_URL not set). The metrics command requires a running connector.\n");
    }
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(rollup, null, 2) + "\n");
  } else {
    process.stdout.write(formatMetricsHuman(rollup) + "\n");
  }
}
