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
 * INF-552: resolve a single label to its ID, creating it on the team if it does
 * not already exist. Used by the `--workflow` authoring trigger so a `wf:<id>`
 * label is always attachable at create time — for a registered workflow this
 * ensures the connector's bootstrap fires even on a team that has never used
 * that workflow before, and for an unknown id it lets the label attach so the
 * engine (the sole registry holder) can loudly reject the ticket rather than
 * the CLI failing opaquely with "Label not found".
 *
 * Lookup is case-insensitive to avoid minting a duplicate of an
 * existing-but-differently-cased label; creation uses the name verbatim.
 */
export async function resolveOrCreateLabelId(teamId: string, labelName: string): Promise<string> {
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
  if (existing) {
    return existing.id;
  }

  const created = await linearGraphQL<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>(
    `
      mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id }
        }
      }
    `,
    { input: { name: labelName, teamId } }
  );

  if (!created.issueLabelCreate.success || !created.issueLabelCreate.issueLabel) {
    throw new Error(`Failed to create label "${labelName}" on team ${teamId}.`);
  }
  return created.issueLabelCreate.issueLabel.id;
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
