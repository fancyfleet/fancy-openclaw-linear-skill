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
 * Resolve a Linear workflow state by its `type` rather than its name.
 *
 * Name-based resolution (findSemanticState) cannot express "the state that MEANS
 * duplicate": teams name that column freely, and a name-list lookup silently
 * misses any name not enumerated. Linear's `type` is the structural fact —
 * exactly one meaning per value — so consolidation verbs resolve by it (AI-2445).
 *
 * Throws (never falls back to another state) when the team has no state of this
 * type: a team without a duplicate column must fail explicitly, not quietly land
 * the ticket in Done and count no-work-performed as delivery.
 */
export async function findStateByType(teamId: string, type: string): Promise<WorkflowState> {
  const target = type.toLowerCase();
  const matching = (states: WorkflowState[]) => states.filter((s) => (s.type ?? "").toLowerCase() === target);

  let matches = matching(await getWorkflowStates(teamId));

  // The states cache is written once and never invalidated, so a team that added
  // its duplicate column after the cache was warmed would fail forever on stale
  // data. A miss is rare and this is the failure path — re-read once from the API
  // before concluding the state genuinely does not exist.
  if (matches.length === 0) {
    matches = matching(await getWorkflowStates(teamId, true));
  }

  if (matches.length === 0) {
    throw new Error(
      `Team ${teamId} has no workflow state of type "${type}", so this command cannot run. ` +
        `Add a "${type}"-type state to the team's workflow in Linear, or use a different command. ` +
        `(Refusing rather than falling back to another state — a wrong resting state is worse than an error.) ` +
        `Try: linear states ${teamId} --refresh`
    );
  }

  // A team may define several states of one type (e.g. two canceled-type columns).
  // Lowest board position is the canonical one; sort explicitly so the choice is
  // deterministic rather than dependent on Linear's node ordering.
  return matches.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
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
