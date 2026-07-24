/**
 * AI-2491 — AC 1: `linear read-state <ID>` returns the current state name and
 * type via a strongly-consistent node query.
 *
 * The distinction under test is the whole point of the ticket. `getIssue`
 * resolves an identifier like "AI-2491" through `issues(filter: {...})` — the
 * eventually-consistent connection feed, which can lag by seconds to minutes
 * after a write. Linear's `issue(id:)` node query accepts the human identifier
 * directly and is strongly consistent. `readState` must use the latter.
 */

import { linearGraphQL } from "../client";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

// `readState` is not implemented yet. Resolve it at runtime rather than via a
// static import so this suite fails on a legible assertion instead of a ts-jest
// compile error on a missing export.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const issuesModule = require("../issues") as Record<string, unknown>;

type ReadState = (id: string) => Promise<{ name: string; type: string; trashed: boolean }>;

function readState(id: string): Promise<{ name: string; type: string; trashed: boolean }> {
  const fn = issuesModule.readState;
  if (typeof fn !== "function") {
    throw new Error(
      "AI-2491 AC1: expected `readState` to be exported from src/issues.ts — not implemented yet"
    );
  }
  return (fn as ReadState)(id);
}

beforeEach(() => {
  mockedGraphQL.mockReset();
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  (process.stderr.write as jest.Mock).mockRestore();
});

describe("AI-2491: readState (AC 1)", () => {
  it("returns the current state name, type, and trashed flag", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: {
        identifier: "AI-2491",
        state: { name: "In Progress", type: "started" },
        trashed: false
      }
    });

    const result = await readState("AI-2491");

    expect(result).toMatchObject({ name: "In Progress", type: "started", trashed: false });
  });

  it("surfaces the trashed flag set to true for deleted tickets", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: {
        identifier: "LIF-35",
        state: { name: "Doing", type: "started" },
        trashed: true
      }
    });

    const result = await readState("LIF-35");

    expect(result).toMatchObject({ name: "Doing", trashed: true });
  });

  it("uses the strongly-consistent issue(id:) node query, not the issues(filter:) connection feed", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: { identifier: "AI-2491", state: { name: "Done", type: "completed" }, trashed: false }
    });

    await readState("AI-2491");

    const query = mockedGraphQL.mock.calls[0][0] as string;
    expect(query).toContain("issue(id:");
    expect(query).not.toContain("issues(filter:");
  });

  it("passes the human identifier straight to the node query rather than decomposing it into team key + number", async () => {
    mockedGraphQL.mockResolvedValue({
      issue: { identifier: "AI-2491", state: { name: "Done", type: "completed" }, trashed: false }
    });

    await readState("AI-2491");

    // The connection-feed path splits "AI-2491" into { teamKey: "AI", number: 2491 }.
    // The node query takes the identifier whole. Assert on the value, not the
    // variable name, so the implementer stays free to name it.
    const variables = (mockedGraphQL.mock.calls[0][1] ?? {}) as Record<string, unknown>;
    expect(Object.values(variables)).toContain("AI-2491");
  });

  it("surfaces a sensible error when the issue is not found", async () => {
    mockedGraphQL.mockResolvedValue({ issue: null });

    await expect(readState("AI-9999")).rejects.toThrow(/not found/i);
    await expect(readState("AI-9999")).rejects.toThrow(/AI-9999/);
  });
});
