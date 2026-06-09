import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { linearGraphQL, LinearApiError } from "./client";
import { getLinearSecretPath } from "./paths";
import { User } from "./types";

interface ViewerResponse {
  viewer: User;
}

interface AgentNameSource {
  source: string;
  value: string;
}

/**
 * Resolve the current agent's name for workspace-based secret file lookup.
 *
 * Priority (highest first):
 *   1. OPENCLAW_MCP_AGENT_ID — set by the OpenClaw MCP runtime when invoking the skill
 *   2. OPENCLAW_AGENT_NAME — explicit user override
 *   3. process.cwd() — derive from workspace directory (multi-agent containers)
 *
 * If multiple sources resolve to different names, a warning is logged and the
 * highest-priority source wins. This prevents silent wrong-agent token selection.
 */
export function resolveAgentName(): { name?: string; sources: AgentNameSource[] } {
  const sources: AgentNameSource[] = [];

  const mcpAgent = process.env.OPENCLAW_MCP_AGENT_ID?.trim();
  if (mcpAgent) sources.push({ source: "OPENCLAW_MCP_AGENT_ID", value: mcpAgent.toLowerCase() });

  const agentName = process.env.OPENCLAW_AGENT_NAME?.trim();
  if (agentName) sources.push({ source: "OPENCLAW_AGENT_NAME", value: agentName.toLowerCase() });

  // Cwd-based fallback: derive agent name from the workspace directory.
  // OpenClaw bash tool runs with PWD = {configDir}/workspace/{agentId}.
  // When cwd is the bare workspace dir (main agent), we do NOT resolve a name.
  const cwdName = resolveAgentNameFromCwd();
  if (cwdName) sources.push({ source: "cwd", value: cwdName.toLowerCase() });

  const distinct = [...new Set(sources.map((s) => s.value))];
  if (distinct.length > 1) {
    const detail = sources.map((s) => `${s.source}=${s.value}`).join(", ");
    console.warn(
      `Linear auth: agent name sources disagree (${detail}). ` +
      `Using highest-priority source '${sources[0].source}'='${sources[0].value}'. ` +
      `Set OPENCLAW_AGENT_NAME explicitly to silence this warning.`,
    );
  }

  return { name: sources[0]?.value, sources };
}

/**
 * Derive agent name from process.cwd().
 *
 * The OpenClaw bash tool sets PWD = {configDir}/workspace/{agentId} for
 * non-main agents and {configDir}/workspace for the main agent. We extract
 * the segment immediately after "workspace" to identify the agent.
 *
 * Returns undefined when cwd is the bare workspace dir (main agent) or
 * when the path doesn't match the expected layout.
 */
export function resolveAgentNameFromCwd(): string | undefined {
  const cwd = process.cwd();
  // Normalize to forward slashes (Windows compat)
  const normalized = cwd.replace(/\\/g, "/");

  // Match .../workspace/<name> or .../workspace/<name>/...
  // but NOT .../workspace alone (that's the main agent).
  const match = normalized.match(/\/workspace\/([^\/]+)(?:\/|$)/);
  if (!match) return undefined;

  const segment = match[1];
  // Reject obvious non-agent segments (dotfiles, hidden dirs, etc.)
  if (segment.startsWith(".")) return undefined;

  return segment;
}

function secretFileCandidates(): string[] {
  const { name } = resolveAgentName();
  if (!name) return [];
  // Canonical path is owned by src/paths.ts so the webhook (writer) and the
  // skill (reader) can never drift again.
  return [getLinearSecretPath(name)];
}

/**
 * Patterns that match credential key names we accept.
 *
 * We accept env var names that look like any of:
 *   LINEAR_DEVELOPER_TOKEN, LINEAR_MCKELL_DEVELOPER_TOKEN
 *   LINEAR_API_KEY, LINEAR_CHARLES_API_KEY
 *   LINEAR_TOKEN
 *
 * The key must contain "linear" AND one of (token|key|developer).
 */
const TOKEN_NAME_PATTERNS = [
  /linear.*developer.*token/i,
  /linear.*api.*key/i,
  /linear.*token/i,
];

function isLinearTokenKey(key: string): boolean {
  return TOKEN_NAME_PATTERNS.some((pattern) => pattern.test(key));
}

function loadApiKeyFromEnvFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (!isLinearTokenKey(key)) {
      continue;
    }

    let value = rawValue.replace(/^['"]|['"]$/g, "").trim();
    if (value.startsWith("op://")) {
      const opBin = process.env.OPENCLAW_OP_BIN ?? "/home/linuxbrew/.linuxbrew/bin/op";
      const opEnvFile = path.join(process.env.HOME ?? "", ".openclaw", "agents", resolveAgentName().name ?? "", "op.env");
      const opEnv: Record<string, string> = { ...process.env as Record<string, string> };
      if (fs.existsSync(opEnvFile)) {
        const opEnvContent = fs.readFileSync(opEnvFile, "utf8");
        for (const l of opEnvContent.split(/\r?\n/)) {
          const m = l.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
          if (m) opEnv[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
        }
      }
      try {
        value = execSync(`${opBin} read "${value}"`, { env: opEnv, encoding: "utf8" }).trim();
      } catch {
        continue;
      }
    }
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Env var names checked in priority order.
 * The first one that is set wins.
 */
function envVarCandidates(): string[] {
  return [
    "LINEAR_OAUTH_TOKEN",
    "LINEAR_API_KEY",
    "LINEAR_DEVELOPER_TOKEN",
  ];
}

const EXTRA_ENV_KEYS = ["LINEAR_PROXY_URL", "LINEAR_ADMIN_SECRET"] as const;

/**
 * Load supplemental LINEAR_* env vars (e.g. LINEAR_PROXY_URL) from the
 * agent's secrets file into process.env, without overriding vars that are
 * already set. Called once during ensureApiKey so proxy routing is available
 * to client.ts before the first GraphQL call.
 */
function loadExtrasFromSecretFiles(): void {
  for (const filePath of secretFileCandidates()) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!(EXTRA_ENV_KEYS as readonly string[]).includes(key)) continue;
      if (process.env[key]) continue; // process env wins
      const value = rawValue.replace(/^['"]|['"]$/g, "").trim();
      if (value) process.env[key] = value;
    }
    break; // only load from the first file found (same precedence as token lookup)
  }
}

export function ensureApiKey(): string {
  loadExtrasFromSecretFiles();

  for (const name of envVarCandidates()) {
    if (process.env[name]) {
      process.env.LINEAR_API_KEY = process.env[name]!;
      return process.env[name]!;
    }
  }

  for (const filePath of secretFileCandidates()) {
    const value = loadApiKeyFromEnvFile(filePath);
    if (value) {
      process.env.LINEAR_API_KEY = value;
      return value;
    }
  }

  const tried = secretFileCandidates().join(", ") || "(no candidates)";
  const agentName = resolveAgentName().name ?? "unknown";
  throw new Error(
    `No Linear API key found for agent ${agentName}. Set LINEAR_OAUTH_TOKEN, LINEAR_API_KEY, or LINEAR_DEVELOPER_TOKEN, or provision .secrets/linear.env. Looked in: ${tried}`
  );
}

export async function checkAuth(): Promise<User> {
  ensureApiKey();
  try {
    const data = await linearGraphQL<ViewerResponse>(`
      query AuthCheck {
        viewer {
          id
          name
          email
        }
      }
    `);
    return data.viewer;
  } catch (error) {
    if (error instanceof LinearApiError && error.code === "UNAUTHORIZED") {
      throw new Error(`LINEAR_API_KEY is invalid: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Run diagnostics on Linear auth and CLI setup
 * Checks: token validity, user identity, and basic read-only operation
 */
/**
 * Get the currently authenticated Linear user (the "self" for semantic commands).
 * Uses the same viewer query as checkAuth but returns a consistent User shape.
 */
export async function getSelfUser(): Promise<User> {
  ensureApiKey();
  const data = await linearGraphQL<ViewerResponse>(`
    query GetSelfUser {
      viewer {
        id
        name
        email
      }
    }
  `);
  return data.viewer;
}

export async function linearDoctor(): Promise<void> {
  console.log("🩺 Linear Doctor\n");
  try {
    const viewer = await checkAuth();
    console.log(`✅ Auth valid\n`);
    console.log(`   User: ${viewer.name} (${viewer.id})`);
    console.log(`   Email: ${viewer.email}`);
  } catch (err) {
    console.log(`❌ Auth failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  try {
    const { listTeams } = await import("./teams.js");
    const teams = await listTeams();
    console.log(`✅ Teams fetch successful (${teams.length} teams)\n`);
  } catch (err) {
    console.log(`❌ Teams fetch failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  try {
    const { getMyIssues } = await import("./issues.js");
    const myIssues = await getMyIssues();
    console.log(`✅ My issues fetch successful (${myIssues.length} issues)\n`);
  } catch (err) {
    console.log(`❌ My issues fetch failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Token type detection
  const apiKey = process.env.LINEAR_API_KEY || "none";
  if (apiKey.startsWith("lin_oauth_")) {
    console.log("✅ Using OAuth token (auto-refreshes every ~20h)\n");
  } else if (apiKey.startsWith("lin_api_")) {
    console.log("✅ Using personal API key (does not expire)\n");
  } else {
    console.log(`⚠️  Unknown token format: ${apiKey.substring(0, 20)}...\n`);
  }
}
