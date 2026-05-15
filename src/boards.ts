import { linearGraphQL } from "./client";
import { STATE_BLOCK, ASSIGNEE_BLOCK, TEAM_BLOCK } from "./fragments";
import { Comment, Issue, IssueHistory } from "./types";

interface TeamIssuesResponse {
  team: {
    issues: {
      nodes: Issue[];
    };
  } | null;
}

interface ViewerIssuesResponse {
  viewer: {
    assignedIssues: {
      nodes: Issue[];
    };
  };
}

interface CommentsResponse {
  issue: {
    comments: {
      nodes: Comment[];
    };
  } | null;
}

interface IssueHistoryResponse {
  issue: {
    history: {
      nodes: IssueHistory[];
    };
  } | null;
}

export async function getBoard(teamId: string): Promise<Record<string, Issue[]>> {
  const data = await linearGraphQL<TeamIssuesResponse>(
    `
      query TeamBoard($teamId: String!) {
        team(id: $teamId) {
          issues(first: 200, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes {
              id
              identifier
              title
              updatedAt
              priority
              ${STATE_BLOCK}
              ${ASSIGNEE_BLOCK}
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

  return data.team.issues.nodes.reduce<Record<string, Issue[]>>((groups, issue) => {
    const key = issue.state?.name ?? "Unspecified";
    groups[key] ??= [];
    groups[key].push(issue);
    return groups;
  }, {});
}

export async function getRecentlyDone(teamId: string, days = 2): Promise<Issue[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const data = await linearGraphQL<TeamIssuesResponse>(
    `
      query TeamRecentlyDone($teamId: String!, $since: DateTimeOrDuration!) {
        team(id: $teamId) {
          issues(
            first: 100,
            filter: {
              state: { type: { in: ["completed", "canceled"] } },
              completedAt: { gte: $since }
            },
            orderBy: updatedAt
          ) {
            nodes {
              id
              identifier
              title
              updatedAt
              priority
              ${STATE_BLOCK}
              ${ASSIGNEE_BLOCK}
            }
          }
        }
      }
    `,
    { teamId, since }
  );

  if (!data.team) {
    throw new Error(`Team not found: ${teamId}`);
  }

  return data.team.issues.nodes;
}

export async function getReviewQueue(): Promise<Issue[]> {
  const data = await linearGraphQL<ViewerIssuesResponse>(`
    query ReviewQueue {
      viewer {
        assignedIssues(first: 100, filter: { state: { name: { eq: "Needs Review" } } }) {
          nodes {
            id
            identifier
            title
            updatedAt
            priority
            ${STATE_BLOCK}
            ${TEAM_BLOCK}
            ${ASSIGNEE_BLOCK}
          }
        }
      }
    }
  `);

  return data.viewer.assignedIssues.nodes;
}

export async function getStalled(days = 2): Promise<Issue[]> {
  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const data = await linearGraphQL<ViewerIssuesResponse>(
    `
      query Stalled($updatedAt: DateTimeOrDuration!) {
        viewer {
          assignedIssues(
            first: 100,
            filter: { state: { name: { eq: "In Progress" } }, updatedAt: { lte: $updatedAt } }
          ) {
            nodes {
              id
              identifier
              title
              updatedAt
              priority
              ${STATE_BLOCK}
              ${TEAM_BLOCK}
              ${ASSIGNEE_BLOCK}
            }
          }
        }
      }
    `,
    { updatedAt: before }
  );

  return data.viewer.assignedIssues.nodes;
}

export async function getComments(issueId: string, all = true): Promise<Comment[]> {
  const data = await linearGraphQL<CommentsResponse>(
    `
      query IssueComments($id: String!, $count: Int!) {
        issue(id: $id) {
          comments(first: $count, orderBy: createdAt) {
            nodes {
              id
              body
              createdAt
              updatedAt
              user {
                id
                name
                email
                app
              }
            }
          }
        }
      }
    `,
    { id: issueId, count: all ? 250 : 10 }
  );

  if (!data.issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  // Linear returns newest-first; reverse for chronological reading order
  return data.issue.comments.nodes.reverse();
}

/**
 * Fetch an issue's history (state, assignee, delegate, priority changes).
 *
 * Returns events sorted ascending by createdAt for direct interleaving with
 * comments in a chronological timeline. Returns up to `count` most recent
 * events (default 50). Each record may describe multiple field changes —
 * inspect the `from*`/`to*` fields to detect which.
 */
export async function getIssueHistory(
  issueId: string,
  count = 50
): Promise<IssueHistory[]> {
  const data = await linearGraphQL<IssueHistoryResponse>(
    `
      query IssueHistory($id: String!, $count: Int!) {
        issue(id: $id) {
          history(first: $count) {
            nodes {
              createdAt
              actor { name }
              fromState { name }
              toState { name }
              fromAssignee { name }
              toAssignee { name }
              fromDelegate { name }
              toDelegate { name }
              fromPriority
              toPriority
            }
          }
        }
      }
    `,
    { id: issueId, count }
  );

  if (!data.issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  // Linear returns newest-first; reverse for chronological reading order
  return data.issue.history.nodes.reverse();
}
