import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { linearGraphQL } from "./client";
import { WorkflowState } from "./types";

/**
 * Maps semantic state names (used by agent commands) to candidate Linear workflow state names.
 * Each semantic state maps to an ordered list of candidates — the first match found in the
 * team's actual workflow states wins. This handles variations across teams (e.g. "Todo" vs "To Do",
 * "Doing" vs "In Progress").
 */
export const SEMANTIC_STATE_MAP: Record<string, string[]> = {
  backlog: ["Backlog"],
  todo: ["Todo", "To Do", "To Develop"],
  thinking: ["Thinking", "In Progress"],
  doing: ["Doing", "In Progress", "Developing"],
  managing: ["Managing"],
  done: ["Done"],
  invalid: ["Invalid", "Canceled", "Cancelled"],
};

const STATE_ALIASES: Record<string, string> = {
  review: "Needs Review",
  done: "Done",
  progress: "In Progress",
  todo: "Todo",
  blocked: "Blocked"
};

interface WorkflowStatesResponse {
  team: {
    id: string;
    key?: string | null;
    states: {
      nodes: WorkflowState[];
    };
  } | null;
}

function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "fancy-openclaw-linear-skill");
}

function cachePath(teamId: string): string {
  return path.join(cacheDir(), `states-${teamId}.json`);
}

async function readCachedStates(teamId: string): Promise<WorkflowState[] | null> {
  try {
    const content = await fs.readFile(cachePath(teamId), "utf8");
    return JSON.parse(content) as WorkflowState[];
  } catch {
    return null;
  }
}

async function writeCachedStates(teamId: string, states: WorkflowState[]): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(cachePath(teamId), JSON.stringify(states, null, 2), "utf8");
}

export async function getWorkflowStates(teamId: string, refresh = false): Promise<WorkflowState[]> {
  if (!refresh) {
    const cached = await readCachedStates(teamId);
    if (cached?.length) {
      return cached;
    }
  }

  const data = await linearGraphQL<WorkflowStatesResponse>(
    `
      query WorkflowStates($teamId: String!) {
        team(id: $teamId) {
          id
          key
          states {
            nodes {
              id
              name
              type
              color
              position
            }
          }
        }
      }
    `,
    { teamId }
  );

  if (!data.team) {
    throw new Error(`Team not found: ${teamId}`);
  }

  await writeCachedStates(teamId, data.team.states.nodes);
  return data.team.states.nodes;
}

export async function findStateByName(teamId: string, alias: string): Promise<WorkflowState> {
  const states = await getWorkflowStates(teamId);
  const targetName = STATE_ALIASES[alias.toLowerCase()] ?? alias;
  const state = states.find((candidate) => candidate.name.toLowerCase() === targetName.toLowerCase());

  if (!state) {
    throw new Error(`No workflow state found for "${alias}" in team ${teamId}. Try: linear states ${teamId} --refresh`);
  }

  return state;
}

/**
 * Resolve a semantic state name to an actual Linear workflow state.
 * Iterates through SEMANTIC_STATE_MAP candidates in order, returning the first match
 * found in the team's workflow states. This handles teams with different naming
 * conventions (e.g. "Todo" vs "To Do", "Doing" vs "In Progress").
 */
export async function findSemanticState(teamId: string, semanticName: string): Promise<WorkflowState> {
  const candidates = SEMANTIC_STATE_MAP[semanticName.toLowerCase()];
  if (!candidates) {
    throw new Error(
      `Unknown semantic state "${semanticName}". Valid options: ${Object.keys(SEMANTIC_STATE_MAP).join(", ")}`
    );
  }

  const states = await getWorkflowStates(teamId);
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

  for (const candidate of candidates) {
    const match = states.find((s) => normalize(s.name) === normalize(candidate));
    if (match) return match;
  }

  throw new Error(
    `No workflow state found for semantic state "${semanticName}" (tried: ${candidates.join(", ")}) in team ${teamId}. Try: linear states ${teamId} --refresh`
  );
}
