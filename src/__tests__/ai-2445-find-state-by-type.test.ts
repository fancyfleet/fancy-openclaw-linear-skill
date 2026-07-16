/**
 * AI-2445: `findStateByType` — resolve a workflow state by Linear's `type` rather
 * than by name.
 *
 * Name-based resolution (SEMANTIC_STATE_MAP) cannot express "the state that MEANS
 * duplicate": a team may name that column anything, and an unenumerated name is a
 * silent miss. These tests exercise the real resolver against fixture state lists —
 * the verb tests mock it out, so this is its only real coverage.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { linearGraphQL } from "../client";
import { findStateByType } from "../states";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn(),
}));

/**
 * getWorkflowStates caches each team's states under os.homedir() and reads that
 * cache before hitting the API, so without redirection every test here would share
 * one cache file and resolve against whichever fixture ran first.
 *
 * Setting process.env.HOME does NOT work: jest's `node` test environment gives the
 * test its own `process` object, while the native `os.homedir()` reads the real
 * process env — the swap is invisible to it. (Observed: HOME=/tmp/x yet
 * os.homedir() → /home/node, which silently let two of these tests pass on a stale
 * cache instead of on the resolver.) Mock the module boundary instead.
 */
let mockHomeDir: string;
jest.mock("node:os", () => {
  const actual = jest.requireActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mockHomeDir ?? actual.homedir() };
});

const mockLinearGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

beforeEach(async () => {
  jest.resetAllMocks();
  mockHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai2445-home-"));
});

afterEach(async () => {
  await fs.rm(mockHomeDir, { recursive: true, force: true });
});

function withStates(states: Array<{ id: string; name: string; type: string; position?: number }>) {
  mockLinearGraphQL.mockResolvedValue({
    team: { id: "team-1", key: "AI", states: { nodes: states } },
  } as any);
}

describe("findStateByType", () => {
  it("resolves by type regardless of what the column is named", async () => {
    withStates([
      { id: "s1", name: "Backlog", type: "backlog" },
      { id: "s2", name: "Consolidated Away", type: "duplicate" },
      { id: "s3", name: "Done", type: "completed" },
    ]);

    const state = await findStateByType("team-1", "duplicate");

    // A name-list lookup for "Duplicate" would miss this column entirely.
    expect(state.id).toBe("s2");
    expect(state.name).toBe("Consolidated Away");
  });

  it("matches type case-insensitively", async () => {
    withStates([{ id: "s2", name: "Duplicate", type: "Duplicate" }]);

    await expect(findStateByType("team-1", "duplicate")).resolves.toMatchObject({ id: "s2" });
  });

  it("does not confuse a state NAMED Duplicate with the duplicate TYPE", async () => {
    // A column named "Duplicate" that is really just a backlog column must not be
    // mistaken for the real thing — type is the structural fact, name is decoration.
    withStates([
      { id: "s1", name: "Duplicate", type: "backlog" },
      { id: "s2", name: "Merged", type: "duplicate" },
    ]);

    const state = await findStateByType("team-1", "duplicate");

    expect(state.id).toBe("s2");
  });

  it("picks the lowest-position state deterministically when a team has several of one type", async () => {
    withStates([
      { id: "s-late", name: "Cancelled (old)", type: "canceled", position: 90 },
      { id: "s-early", name: "Invalid", type: "canceled", position: 10 },
    ]);

    await expect(findStateByType("team-1", "canceled")).resolves.toMatchObject({ id: "s-early" });
  });

  it("re-reads past a stale cache before declaring the state missing", async () => {
    // Warm the cache with a state list that predates the team adding its duplicate
    // column, then have the API return the current list. The cache is never
    // invalidated, so without the refresh this would fail forever on stale data.
    withStates([{ id: "s1", name: "Backlog", type: "backlog" }]);
    await expect(findStateByType("team-1", "backlog")).resolves.toMatchObject({ id: "s1" });

    withStates([
      { id: "s1", name: "Backlog", type: "backlog" },
      { id: "s2", name: "Duplicate", type: "duplicate" },
    ]);

    await expect(findStateByType("team-1", "duplicate")).resolves.toMatchObject({ id: "s2" });
  });

  it("throws — never falls back — when the team has no state of that type", async () => {
    withStates([
      { id: "s1", name: "Backlog", type: "backlog" },
      { id: "s3", name: "Done", type: "completed" },
    ]);

    // AC4: silently landing in Done is the exact failure this verb exists to end.
    await expect(findStateByType("team-1", "duplicate")).rejects.toThrow(
      /has no workflow state of type "duplicate"/
    );
  });

  it("names a remedy in the missing-state error", async () => {
    withStates([{ id: "s3", name: "Done", type: "completed" }]);

    await expect(findStateByType("team-1", "duplicate")).rejects.toThrow(/Add a "duplicate"-type state/);
  });
});
