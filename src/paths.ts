import os from "node:os";
import path from "node:path";

/**
 * Options for path resolution. `configDir` overrides the default
 * `$OPENCLAW_CONFIG_DIR` (or `~/.openclaw`) lookup — useful in tests.
 */
export interface PathOptions {
  configDir?: string;
}

function resolveConfigDir(opts?: PathOptions): string {
  if (opts?.configDir) return opts.configDir;
  if (process.env.OPENCLAW_CONFIG_DIR) return process.env.OPENCLAW_CONFIG_DIR;
  // Prefer $HOME so tests that override it at runtime resolve consistently;
  // fall back to os.homedir() (e.g. when HOME is unset under a service).
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, ".openclaw");
}

/**
 * Resolve the workspace directory for an OpenClaw agent.
 *
 * Canonical layout:
 *   - main agent:   `{configDir}/workspace`
 *   - other agents: `{configDir}/workspace/{agentId}`
 */
export function getAgentWorkspaceDir(agentId: string, opts?: PathOptions): string {
  const configDir = resolveConfigDir(opts);
  if (agentId === "main") {
    return path.join(configDir, "workspace");
  }
  return path.join(configDir, "workspace", agentId);
}

/**
 * Resolve the canonical Linear OAuth token path for an OpenClaw agent.
 *
 * Single source of truth for both the Linear skill (reader) and the
 * Linear webhook (writer). Both must import this helper rather than
 * computing the path themselves, so the two sides can never disagree.
 */
export function getLinearSecretPath(agentId: string, opts?: PathOptions): string {
  return path.join(getAgentWorkspaceDir(agentId, opts), ".secrets", "linear.env");
}
