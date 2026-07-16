import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { linearGraphQL } from "./client";
import { AnnotatedIssueRelation, IssueRelation, RelationDirection } from "./types";
import { getIssue, updateIssue } from "./issues";

interface RelationMutationResponse {
  issueRelationCreate?: {
    success: boolean;
  };
  issueRelationDelete?: {
    success: boolean;
  };
}

/**
 * Inbound rewordings for the relation types whose direction carries meaning.
 * `related` and `similar` are symmetric, so they read the same from either end.
 */
const INBOUND_LABELS: Record<string, string> = {
  blocks: "blocked-by",
  duplicate: "duplicate-of"
};

/** Restate a relation type from the point of view of the issue that was queried. */
export function relationLabel(type: string | null | undefined, direction: RelationDirection): string {
  const relationType = type ?? "related";
  if (direction === "outbound") return relationType;
  return INBOUND_LABELS[relationType] ?? relationType;
}

function annotate(relations: IssueRelation[], direction: RelationDirection): AnnotatedIssueRelation[] {
  return relations.map((relation) => ({
    ...relation,
    direction,
    relation: relationLabel(relation.type, direction)
  }));
}

/**
 * Every relation touching `issueId`, in both directions.
 *
 * Linear splits these across two fields: `relations` (this issue is the source)
 * and `inverseRelations` (this issue is the target). Returning only the former
 * hid an issue's own blockers, which made the standing "link the blocker, then
 * verify with `linear relations`" rule structurally unable to confirm the link
 * it was checking for (AI-2452).
 *
 * Each edge is labelled so the two directions stay distinguishable: an inbound
 * `blocks` edge is reported as `blocked-by`, never merged into `blocks`.
 */
export async function listRelations(issueId: string): Promise<AnnotatedIssueRelation[]> {
  const issue = await getIssue(issueId);
  return [...annotate(issue.relations ?? [], "outbound"), ...annotate(issue.inverseRelations ?? [], "inbound")];
}

export async function createBlockingRelation(
  issueId: string,
  relatedIssueId: string,
  mode: "blocked-by" | "blocks",
  confirm = true
): Promise<{ issueId: string; relatedIssueId: string; mode: string }> {
  const [issue, relatedIssue] = await Promise.all([getIssue(issueId), getIssue(relatedIssueId)]);

  const prompt =
    mode === "blocked-by"
      ? `${issue.identifier} will be blocked by ${relatedIssue.identifier} (${relatedIssue.identifier} must complete before ${issue.identifier}). Confirm? [y/N] `
      : `${issue.identifier} will block ${relatedIssue.identifier} (${issue.identifier} must complete before ${relatedIssue.identifier}). Confirm? [y/N] `;

  if (confirm) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(prompt);
    rl.close();
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      throw new Error("Aborted.");
    }
  }

  const [prerequisiteId, dependentId] =
    mode === "blocked-by" ? [relatedIssue.id, issue.id] : [issue.id, relatedIssue.id];

  const data = await linearGraphQL<RelationMutationResponse>(
    `
      mutation CreateRelation($issueId: String!, $relatedIssueId: String!) {
        issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) {
          success
        }
      }
    `,
    {
      issueId: prerequisiteId,
      relatedIssueId: dependentId
    }
  );

  if (!data.issueRelationCreate?.success) {
    throw new Error("Failed to create relation.");
  }

  return { issueId: issue.identifier, relatedIssueId: relatedIssue.identifier, mode };
}

export async function removeBlockingRelation(issueId: string, relatedIssueId: string): Promise<{ removed: boolean }> {
  let relations = await listRelations(issueId);
  if (relations.length === 0) {
    relations = await listRelations(relatedIssueId);
  }
  const relation = relations.find((candidate) => {
    const a = candidate.issue.identifier;
    const b = candidate.relatedIssue.identifier;
    return [a, b].includes(issueId) && [a, b].includes(relatedIssueId);
  });

  if (!relation) {
    throw new Error(`No relation found between ${issueId} and ${relatedIssueId}.`);
  }

  const data = await linearGraphQL<RelationMutationResponse>(
    `
      mutation DeleteRelation($id: String!) {
        issueRelationDelete(id: $id) {
          success
        }
      }
    `,
    { id: relation.id }
  );

  if (!data.issueRelationDelete?.success) {
    throw new Error("Failed to delete relation.");
  }

  return { removed: true };
}


export async function setParentIssue(issueId: string, parentIssueId: string) {
  const [issue, parentIssue] = await Promise.all([getIssue(issueId), getIssue(parentIssueId)]);

  if (issue.id === parentIssue.id) {
    throw new Error("An issue cannot be its own parent.");
  }

  const updated = await updateIssue(issue.id, { parentId: parentIssue.id });

  return {
    issueId: updated.identifier,
    parentId: updated.parent?.identifier ?? parentIssue.identifier,
    issue: updated
  };
}

export async function removeParentIssue(issueId: string) {
  const issue = await getIssue(issueId);
  const previousParent = issue.parent?.identifier ?? null;

  const updated = await updateIssue(issue.id, { parentId: null });

  return {
    issueId: updated.identifier,
    previousParent,
    issue: updated
  };
}
