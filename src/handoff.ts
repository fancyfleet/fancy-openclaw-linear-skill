import fs from "node:fs/promises";

import { addComment, findUserByName, getIssue, updateIssue } from "./issues";
import { findStateByName } from "./states";

export async function handoffIssue(
  issueId: string,
  reviewerName: string,
  comment?: string,
  commentFile?: string
): Promise<{ issueId: string; reviewer: string; state: string; commentPosted: boolean; commentId: string }> {
  const issue = await getIssue(issueId);
  const body = commentFile ? await fs.readFile(commentFile, "utf8") : comment;
  if (!body?.trim()) {
    throw new Error("Handoff requires a non-empty comment. Use a body argument or --comment-file.");
  }

  const reviewer = await findUserByName(reviewerName);
  if (issue.assignee?.id === reviewer.id) {
    throw new Error(`Reviewer ${reviewer.name} is already the assignee for ${issue.identifier}. Choose a different reviewer.`);
  }

  const teamId = issue.team?.id;
  if (!teamId) {
    throw new Error(`Issue ${issue.identifier} has no team.`);
  }

  const reviewState = await findStateByName(teamId, "review");

  let commentId: string;
  try {
    const commentResult = await addComment(issueId, body);
    commentId = commentResult.commentId;
  } catch (error) {
    throw new Error(
      `Handoff failed at step commentCreate for ${issue.identifier}. Current assignee: ${issue.assignee?.name ?? "Unassigned"}, state: ${issue.state?.name ?? "Unknown"}. Recovery: linear comment ${issue.identifier} --body-file <path>`
    );
  }

  // Linear rejects { assigneeId: app_user, delegateId: <anything> } (AI-1395).
  // For app-user reviewers, send only delegateId and omit assigneeId entirely.
  const reviewerIsAppUser = reviewer.app === true;
  const updatePayload = reviewerIsAppUser
    ? { delegateId: reviewer.id, stateId: reviewState.id }
    : { assigneeId: reviewer.id, stateId: reviewState.id, delegateId: null };

  try {
    await updateIssue(issueId, updatePayload);
  } catch {
    throw new Error(
      `Handoff failed at step issueUpdate for ${issue.identifier}. Comment may already be posted. Recovery: linear update-issue ${issue.identifier} --assignee "${reviewer.id}" --state "${reviewState.name}" --team ${teamId}`
    );
  }

  return {
    issueId: issue.identifier,
    reviewer: reviewer.name,
    state: reviewState.name,
    commentPosted: true,
    commentId,
  };
}
