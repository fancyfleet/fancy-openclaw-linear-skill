import { linearGraphQL } from "./client";
import { getIssue } from "./issues";
import { resolveTeamId } from "./teams";

interface LabelsResponse {
  team: {
    labels: {
      nodes: Array<{ id: string; name: string; color: string }>;
    };
  };
}



export async function listLabels(team?: string): Promise<Array<{ id: string; name: string; color: string }>> {
  const teamId = team ? await resolveTeamId(team) : undefined;
  const teamClause = teamId
    ? `team(id: "${teamId}") { labels(first: 100) { nodes { id name color } } }`
    : `teams(first: 1) { nodes { labels(first: 100) { nodes { id name color } } } }`;

  const data = await linearGraphQL<{
    teams?: { nodes: Array<{ labels: LabelsResponse["team"]["labels"] }> };
    team?: LabelsResponse["team"];
  }>(
    `
      query ListLabels {
        ${teamClause}
      }
    `
  );

  if (data.team) {
    return data.team.labels.nodes;
  }
  if (data.teams?.nodes?.length) {
    return data.teams.nodes[0].labels.nodes;
  }
  return [];
}

export async function resolveLabelIds(teamId: string, labelNames: string[]): Promise<string[]> {
  const data = await linearGraphQL<LabelsResponse>(
    `
      query ResolveLabels($teamId: String!) {
        team(id: $teamId) {
          labels(first: 100) {
            nodes { id name color }
          }
        }
      }
    `,
    { teamId }
  );

  const teamLabels = data.team.labels.nodes;
  const resolved: string[] = [];
  const notFound: string[] = [];

  for (const name of labelNames) {
    const match = teamLabels.find(
      (l) => l.name.toLowerCase() === name.toLowerCase()
    );
    if (match) {
      resolved.push(match.id);
    } else {
      notFound.push(name);
    }
  }

  if (notFound.length > 0) {
    throw new Error(`Label(s) not found: ${notFound.join(", ")}. Available labels: ${teamLabels.map((l) => l.name).join(", ") || "(none)"}`);
  }

  return resolved;
}

/**
 * INF-552: resolve a label that must already exist on the team, WITHOUT
 * creating it. Used by the `--workflow` authoring trigger to attach the fixed
 * `wf:pending` sentinel: an agent OAuth actor token cannot create IssueLabels
 * (Linear returns 400), so the CLI never attempts creation — the sentinel is a
 * one-time provisioned label. A missing sentinel is an infra-provisioning gap,
 * surfaced with an actionable message rather than an opaque 400.
 *
 * Lookup is case-insensitive to match an existing-but-differently-cased label.
 */
export async function resolveExistingLabelId(teamId: string, labelName: string): Promise<string> {
  const data = await linearGraphQL<LabelsResponse>(
    `
      query ResolveLabels($teamId: String!) {
        team(id: $teamId) {
          labels(first: 100) {
            nodes { id name color }
          }
        }
      }
    `,
    { teamId }
  );

  const existing = data.team.labels.nodes.find(
    (l) => l.name.toLowerCase() === labelName.toLowerCase()
  );
  if (!existing) {
    throw new Error(
      `Sentinel label "${labelName}" is not provisioned on this team. ` +
        `It must be created once (a fixed, taxonomy-free marker) before --workflow authoring can be used. ` +
        `Ask an operator to add the "${labelName}" label to the team.`
    );
  }
  return existing.id;
}

export async function addLabels(issueId: string, labelNames: string[], teamId?: string): Promise<unknown> {
  const issue = await getIssue(issueId);
  const tid = teamId ?? issue.team?.id;
  if (!tid) {
    throw new Error(`Unable to resolve team for issue ${issueId}. Pass --team explicitly.`);
  }

  const labelIds = await resolveLabelIds(tid, labelNames);

  const data = await linearGraphQL<{ issueUpdate: { success: boolean; issue: { id: string; labels: { nodes: Array<{ id: string; name: string }> } } } }>(
    `
      mutation AddLabels($id: String!, $addedLabelIds: [String!]) {
        issueUpdate(input: { addedLabelIds: $addedLabelIds }, id: $id) {
          success
          issue { id labels { nodes { id name } } }
        }
      }
    `,
    { id: issue.id, addedLabelIds: labelIds }
  );

  return data.issueUpdate;
}

export async function removeLabels(issueId: string, labelNames: string[], teamId?: string): Promise<unknown> {
  const issue = await getIssue(issueId);
  const tid = teamId ?? issue.team?.id;
  if (!tid) {
    throw new Error(`Unable to resolve team for issue ${issueId}. Pass --team explicitly.`);
  }

  const labelIdsToRemove = await resolveLabelIds(tid, labelNames);

  const data = await linearGraphQL<{ issueUpdate: { success: boolean; issue: { id: string; labels: { nodes: Array<{ id: string; name: string }> } } } }>(
    `
      mutation RemoveLabels($id: String!, $removedLabelIds: [String!]) {
        issueUpdate(input: { removedLabelIds: $removedLabelIds }, id: $id) {
          success
          issue { id labels { nodes { id name } } }
        }
      }
    `,
    { id: issue.id, removedLabelIds: labelIdsToRemove }
  );

  return data.issueUpdate;
}
