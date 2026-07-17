import { linearGraphQL, LinearApiError } from "../client";
import { getIssue } from "../issues";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;

const rawIssue = (identifier: string) => ({
  id: "uuid-inf-27",
  identifier,
  title: "sprint-spawner: empty barrier auto-satisfies",
  description: "",
  url: `https://linear.app/fancymatt/issue/${identifier}`,
  priority: 0,
  priorityLabel: "No priority",
  estimate: null,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
  state: { id: "state-1", name: "Doing", type: "started" },
  team: { id: "team-inf", key: "INF", name: "Infrastructure" },
  assignee: null,
  creator: null,
  project: null,
  projectMilestone: null,
  labels: { nodes: [] },
  parent: null,
  children: { nodes: [] },
  relations: { nodes: [] },
  comments: { nodes: [] }
});

/**
 * The live "no such issue" response: HTTP 200 carrying a GraphQL `errors`
 * array, which linearGraphQL turns into a LinearApiError. Captured verbatim
 * from the API — `issue(id:)` never returns `{ issue: null }` for a bad id.
 */
const entityNotFound = () =>
  new LinearApiError(
    "Entity not found: Issue\n  ↳ field: issue\n  ↳ detail: Could not find referenced Issue.",
    "GRAPHQL_ERROR",
    [
      {
        message: "Entity not found: Issue",
        path: ["issue"],
        extensions: {
          type: "invalid input",
          code: "INPUT_ERROR",
          statusCode: 400,
          userError: true,
          userPresentableMessage: "Could not find referenced Issue."
        }
      } as never
    ]
  );

describe("getIssue resolves identifiers through the issue(id:) node query (INF-29)", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  // AC1: the decompose-into-team-key-and-number filter is what breaks on a
  // team move. An identifier must go to the node query verbatim.
  it("sends the identifier to the node query instead of a team+number filter", async () => {
    mockedGraphQL.mockResolvedValue({ issue: rawIssue("INF-27") });

    await getIssue("AI-2535");

    const [query, variables] = mockedGraphQL.mock.calls[0];
    expect(query).toEqual(expect.stringContaining("issue(id: $id)"));
    expect(query).not.toEqual(expect.stringContaining("IssueByIdentifier"));
    expect(variables).toEqual({ id: "AI-2535" });
  });

  // The founding incident: AI-2535 was retired by a team move to INF-27.
  // Linear's node query still resolves the retired identifier; the filter
  // matched nothing, which is why `observe-issue AI-2535` reported not-found
  // on an issue that plainly exists.
  it("resolves an identifier retired by a team move, returning the live one", async () => {
    mockedGraphQL.mockResolvedValue({ issue: rawIssue("INF-27") });

    const result = await getIssue("AI-2535");

    expect(result.identifier).toBe("INF-27");
    expect(result.team?.key).toBe("INF");
  });

  it("passes a lowercase identifier through without upcasing it", async () => {
    mockedGraphQL.mockResolvedValue({ issue: rawIssue("INF-27") });

    await getIssue("inf-27");

    expect(mockedGraphQL.mock.calls[0][1]).toEqual({ id: "inf-27" });
  });

  it("still routes a bare UUID to the node query", async () => {
    mockedGraphQL.mockResolvedValue({ issue: rawIssue("INF-27") });

    await getIssue("uuid-inf-27");

    expect(mockedGraphQL.mock.calls[0][1]).toEqual({ id: "uuid-inf-27" });
  });

  // Contract guard. Dropping the filter branch moves the not-found path from
  // an empty node list to a thrown LinearApiError whose message names neither
  // the id nor "Issue not found". Callers and humans depend on that message,
  // so it has to survive the rewrite.
  it("reports a genuinely missing issue as `Issue not found: <id>`", async () => {
    mockedGraphQL.mockRejectedValue(entityNotFound());

    await expect(getIssue("AI-99999")).rejects.toThrow("Issue not found: AI-99999");
  });

  it("does not swallow unrelated API errors as not-found", async () => {
    mockedGraphQL.mockRejectedValue(new LinearApiError("Unauthorized", "UNAUTHORIZED"));

    await expect(getIssue("INF-27")).rejects.toThrow("Unauthorized");
  });
});
