import fs from "node:fs/promises";

import {
  executeTransition,
  findRecentDuplicate,
  getInlineCommentSafetyWarning,
  type DuplicateMatch,
  type TransitionArgs,
  type TransitionResult,
} from "./state-machine";
import {
  checkMattEscalation,
  formatRefusalError,
  isMattTarget,
  logRefusal,
} from "./matt-escalation-guard";
import { setProxyIntent, setProxyTarget } from "./client";
import { getComments, getIssueHistory } from "./boards";
import { addComment, getIssue, updateIssue } from "./issues";
import { resolveLabelIds } from "./labels";
import { IssueHistory } from "./types";

const AGENT_REVIEW_LABEL = "gate:agent-review";
const HUMAN_REVIEW_LABEL = "gate:human-review";
const REVIEW_HANDOFF_PREFIX = "[Review Handoff]";

const BACKLOG_CONSIDER_WORK_ERROR = "Ticket is in Backlog — cannot consider work. Use `linear observe-issue` to view, or wait for promotion to To Do.";
const BACKLOG_FORCE_WARNING = "⚠️  Warning: forced past Backlog gate for consider-work. This ticket was explicitly parked.";

function isBacklogState(state?: { name?: string | null } | null): boolean {
  return (state?.name ?? "").toLowerCase() === "backlog";
}

/**
 * One state/delegate/assignee/priority change derived from Linear's issue
 * history. A single Linear history record may produce multiple events (e.g.
 * a state change and a delegate change in one update become two events).
 */
export interface TimelineEvent {
  createdAt: string;
  actor: string | null;
  type: "state" | "delegate" | "assignee" | "priority";
  from: string | null;
  to: string | null;
}

/**
 * Result of observing an issue. Comments and history are both sorted
 * ascending by createdAt.
 */
export interface ObserveResult {
  identifier: string;
  title: string;
  description: string;
  createdAt: string;
  state: { name: string };
  priority: number;
  assignee: { name: string } | null;
  delegate: { name: string } | null;
  labels: Array<{ name: string; color?: string | null }>;
  /** Sorted ascending by createdAt */
  comments: Array<{ id: string; body: string; createdAt: string; user: { name: string; isAgent?: boolean | null; app?: boolean | null } }>;
  /** Sorted ascending by createdAt */
  history: TimelineEvent[];
}

export interface SemanticResult {
  command: string;
  issueId: string;
  state: string;
  delegate: string | null;
  assignee: string | null;
  commentPosted: boolean;
  /** True when a near-duplicate comment was detected and the post was refused. */
  duplicateBlocked: boolean;
  duplicateDetails: { existingCommentId: string; similarity: number; ageSeconds: number } | null;
  commentId: string | null;
  commentUrl: string | null;
  commentCreatedAt: string | null;
  commentBodyLength: number | null;
  bodyFile: string | null;
}

/**
 * linear observeIssue <id> [--all]
 *
 * Read-only observation of an issue. Does NOT change ownership.
 * Used when an agent is @mentioned (not delegated) or doing a board sweep.
 * Returns issue context + last 10 comments by default (or all with --all).
 */
export async function observeIssue(
  issueId: string,
  allComments = false,
  sinceTimestamp?: string
): Promise<ObserveResult> {
  const issue = await getIssue(issueId);
  const [comments, history] = await Promise.all([
    getComments(issue.id, allComments),
    getIssueHistory(issue.id),
  ]);

  const rawComments = comments.map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.createdAt ?? "",
    user: c.user ? { name: c.user.name, isAgent: c.user.isAgent, app: c.user.app } : { name: "Unknown" },
  }));

  // Explicit ascending sort by createdAt (guarantee for consumers)
  rawComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const filteredComments = sinceTimestamp
    ? rawComments.filter((c) => c.createdAt >= sinceTimestamp)
    : rawComments;

  return {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    createdAt: issue.createdAt ?? "",
    state: { name: issue.state?.name ?? "Unknown" },
    priority: issue.priority ?? 0,
    assignee: issue.assignee ? { name: issue.assignee.name } : null,
    delegate: issue.delegate ? { name: issue.delegate.name } : null,
    labels: (issue.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    comments: filteredComments,
    history: historyToTimelineEvents(history),
  };
}

/**
 * Flatten Linear's IssueHistory records into per-field TimelineEvents.
 * A single history record can contain multiple field changes — we emit one
 * event per non-null change so consumers can render each on its own line.
 * Result is sorted ascending by createdAt.
 */
export function historyToTimelineEvents(history?: IssueHistory[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (!history || !Array.isArray(history)) return events;
  for (const h of history) {
    const actor = h.actor?.name ?? null;
    if (h.fromState || h.toState) {
      events.push({
        createdAt: h.createdAt, actor, type: "state",
        from: h.fromState?.name ?? null, to: h.toState?.name ?? null,
      });
    }
    if (h.fromDelegate || h.toDelegate) {
      events.push({
        createdAt: h.createdAt, actor, type: "delegate",
        from: h.fromDelegate?.name ?? null, to: h.toDelegate?.name ?? null,
      });
    }
    if (h.fromAssignee || h.toAssignee) {
      events.push({
        createdAt: h.createdAt, actor, type: "assignee",
        from: h.fromAssignee?.name ?? null, to: h.toAssignee?.name ?? null,
      });
    }
    if (h.fromPriority !== null || h.toPriority !== null) {
      events.push({
        createdAt: h.createdAt, actor, type: "priority",
        from: h.fromPriority !== null ? String(h.fromPriority) : null,
        to: h.toPriority !== null ? String(h.toPriority) : null,
      });
    }
  }
  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return events;
}

/**
 * linear considerWork <id>
 *
 * Agent received a webhook notification and is considering the task.
 * Context gateway: returns issue info + last 10 comments.
 * - Set delegate = self
 * - Set status to "thinking" (maps to In Progress)
 * - Clear assignee
 * - No comment (agents only comment through handoffs)
 */
export async function considerWork(
  issueId: string,
  options?: { force?: boolean }
): Promise<SemanticResult & { context?: ObserveResult }> {
  const issue = await getIssue(issueId);
  if (isBacklogState(issue.state)) {
    if (!options?.force) {
      throw new Error(BACKLOG_CONSIDER_WORK_ERROR);
    }
    process.stderr.write(`${BACKLOG_FORCE_WARNING}\n`);
  }

  return executeTransition("considerWork", { issueId }, {
    targetState: "thinking",
    commentMode: "none",
    delegateToSelf: true,
    clearAssignee: true,
    includeContext: true,
    skipIfSameState: true,
    noopOnTerminal: !options?.force,
    requireSelfAssignedOrDelegated: !options?.force,
  });
}

/**
 * linear refuseWork <id> <delegate>
 *
 * Agent decides they are not the best person for the next action.
 * - Set status to Todo
 * - Post comment (required)
 * - Set delegate to the specified user
 */
export async function refuseWork(
  issueId: string,
  delegateName: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  return executeTransition("refuseWork", {
    issueId,
    comment: options?.comment,
    commentFile: options?.commentFile,
    userName: delegateName,
    commandName: "refuse-work",
    forceDuplicate: options?.forceDuplicate,
  }, {
    targetState: "todo",
    commentMode: "optional-with-warning",
    delegateName: (args) => args.userName,
    commentFirst: true,
  });
}

/**
 * linear beginWork <id>
 *
 * Agent is actively handling the delegated task. Idempotent.
 * - Set status to "doing" (maps to In Progress)
 * - Does NOT change delegate
 * - No comment (agents only comment through handoffs)
 */
export async function beginWork(
  issueId: string
): Promise<SemanticResult> {
  return executeTransition("beginWork", { issueId }, {
    targetState: "doing",
    commentMode: "none",
    skipIfSameState: true,
  });
}

async function resolveCommentText(options?: { comment?: string; commentFile?: string }): Promise<string> {
  if (options?.commentFile) {
    try {
      return (await fs.readFile(options.commentFile, "utf8")).trim();
    } catch {
      return "";
    }
  }
  return options?.comment?.trim() ?? "";
}

async function guardMattEscalation(
  issueId: string,
  targetName: string,
  options?: { comment?: string; commentFile?: string; forceMattEscalation?: boolean }
): Promise<void> {
  if (!isMattTarget(targetName)) return;
  const text = await resolveCommentText(options);
  const refusal = checkMattEscalation(text);
  if (!refusal) return;
  await logRefusal(issueId, refusal, !!options?.forceMattEscalation);
  if (!options?.forceMattEscalation) {
    throw new Error(formatRefusalError(issueId, refusal));
  }
  process.stderr.write(
    `⚠️  --force-matt-escalation used: bypassing refusal for category "${refusal.category}".\n`
  );
}

/**
 * linear handoffWork <id> <delegate>
 *
 * Agent-to-agent handoff. Idempotent — safe to call multiple times.
 * - Set status to Todo
 * - Post comment (required)
 * - Set delegate to specified agent
 * - Clear assignee
 *
 * With reviewHandoff: also applies the gate:agent-review label atomically
 * and prefixes the comment with `[Review Handoff]` if not already present.
 * Fails before any mutation if the label is missing on the target team.
 */
export async function handoffWork(
  issueId: string,
  delegateName: string,
  options?: {
    comment?: string;
    commentFile?: string;
    forceDuplicate?: boolean;
    forceMattEscalation?: boolean;
    reviewHandoff?: boolean;
  }
): Promise<SemanticResult> {
  await guardMattEscalation(issueId, delegateName, options);

  let comment = options?.comment;
  let commentFile = options?.commentFile;
  if (options?.reviewHandoff) {
    if (commentFile) {
      const raw = (await fs.readFile(commentFile, "utf8")).trim();
      comment = raw.startsWith(REVIEW_HANDOFF_PREFIX) ? raw : `${REVIEW_HANDOFF_PREFIX}\n\n${raw}`;
      commentFile = undefined;
    } else if (comment) {
      const trimmed = comment.trim();
      if (!trimmed.startsWith(REVIEW_HANDOFF_PREFIX)) {
        comment = `${REVIEW_HANDOFF_PREFIX}\n\n${trimmed}`;
      }
    }

    const issue = await getIssue(issueId);
    const teamId = issue.team?.id;
    if (!teamId) {
      throw new Error(`Issue ${issue.identifier} has no team — cannot apply ${AGENT_REVIEW_LABEL}.`);
    }
    try {
      await resolveLabelIds(teamId, [AGENT_REVIEW_LABEL]);
    } catch {
      throw new Error(
        `--review-handoff requires the "${AGENT_REVIEW_LABEL}" label on team ${issue.team?.key ?? teamId}, but it doesn't exist. ` +
        `Create it via the GraphQL issueLabelCreate mutation (see agent-review-handoff-convention.md for the recipe), then re-run.`
      );
    }
  }

  return executeTransition("handoffWork", {
    issueId,
    comment,
    commentFile,
    userName: delegateName,
    commandName: "handoff-work",
    forceDuplicate: options?.forceDuplicate,
  }, {
    targetState: "todo",
    commentMode: "optional-with-warning",
    delegateName: (args) => args.userName,
    clearAssignee: true,
    commentFirst: true,
    addLabels: options?.reviewHandoff ? [AGENT_REVIEW_LABEL] : undefined,
  });
}

/**
 * linear complete <id>
 *
 * Ticket has reached the desired acceptance criteria state.
 * - Set status to Done
 * - Post comment (optional)
 * - Clear delegate
 * - Clear assignee
 * - Strip review-gate labels (gate:agent-review, gate:human-review) if present
 */
export async function complete(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("complete");
  try {
    return await executeTransition("complete", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "done",
      commentMode: "optional",
      clearDelegate: true,
      clearAssignee: true,
      removeLabelsIfPresent: [AGENT_REVIEW_LABEL, HUMAN_REVIEW_LABEL],
    });
  } finally {
    setProxyIntent(undefined);
  }
}

export interface NoteResult {
  issueId: string;
  commentId: string | null;
  commentPosted: boolean;
  duplicateBlocked: boolean;
  duplicateDetails: { existingCommentId: string; similarity: number; ageSeconds: number } | null;
  commentUrl: string | null;
  commentCreatedAt: string | null;
  commentBodyLength: number | null;
  bodyFile: string | null;
}

/**
 * linear note <id>
 *
 * Post a comment on an issue without changing any state, delegate, or assignee.
 * Works on issues in any status including Done and Canceled.
 * Comment is required (--comment or --comment-file).
 */
export async function note(
  issueId: string,
  options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<NoteResult> {
  let body = options.comment?.trim();
  if (options.commentFile) {
    body = (await fs.readFile(options.commentFile, "utf8")).trim();
  } else if (body) {
    const warning = getInlineCommentSafetyWarning(body);
    if (warning) {
      process.stderr.write(`${warning}\n`);
    }
  }
  if (!body) {
    throw new Error("note requires a non-empty comment. Use --comment or --comment-file.");
  }
  const issue = await getIssue(issueId);
  const dup: DuplicateMatch | null = options.forceDuplicate ? null : await findRecentDuplicate(issue.id, body);
  if (dup) {
    return {
      issueId: issue.identifier,
      commentId: dup.id,
      commentPosted: false,
      duplicateBlocked: true,
      duplicateDetails: { existingCommentId: dup.id, similarity: dup.similarity, ageSeconds: dup.ageSeconds },
      commentUrl: null,
      commentCreatedAt: dup.createdAt,
      commentBodyLength: Buffer.byteLength(body, "utf8"),
      bodyFile: null,
    };
  }
  const commentResult = await addComment(issue.id, body);
  return {
    issueId: issue.identifier,
    commentId: commentResult.commentId,
    commentPosted: true,
    duplicateBlocked: false,
    duplicateDetails: null,
    commentUrl: commentResult.commentUrl,
    commentCreatedAt: commentResult.commentCreatedAt,
    commentBodyLength: commentResult.commentBodyLength,
    bodyFile: commentResult.bodyFile ?? null
  };
}

/**
 * linear undelegate <id>
 *
 * Clear agent/human ownership without changing workflow state.
 * Use when work should no longer be owned by the current delegate, but the
 * ticket should stay exactly where it is on the board.
 * - Preserve current status
 * - Clear delegate
 * - Clear assignee
 * - Post comment (optional)
 */
export async function undelegate(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  const issue = await getIssue(issueId);
  let body = options?.comment?.trim();
  if (options?.commentFile) {
    body = (await fs.readFile(options.commentFile, "utf8")).trim();
  } else if (body) {
    const warning = getInlineCommentSafetyWarning(body);
    if (warning) {
      process.stderr.write(`${warning}\n`);
    }
  }

  let commentPosted = false;
  let duplicateBlocked = false;
  let duplicateDetails: SemanticResult["duplicateDetails"] = null;
  let commentId: string | null = null;
  let commentUrl: string | null = null;
  let commentCreatedAt: string | null = null;
  let commentBodyLength: number | null = null;
  let bodyFile: string | null = null;

  if (body) {
    const dup = options?.forceDuplicate ? null : await findRecentDuplicate(issue.id, body);
    if (dup) {
      duplicateBlocked = true;
      duplicateDetails = { existingCommentId: dup.id, similarity: dup.similarity, ageSeconds: dup.ageSeconds };
      commentId = dup.id;
      commentCreatedAt = dup.createdAt;
      commentBodyLength = Buffer.byteLength(body, "utf8");
    } else {
      const result = await addComment(issue.id, body);
      commentPosted = true;
      commentId = result.commentId;
      commentUrl = result.commentUrl;
      commentCreatedAt = result.commentCreatedAt;
      commentBodyLength = result.commentBodyLength;
      bodyFile = result.bodyFile ?? null;
    }
  }

  const updatedIssue = await updateIssue(issueId, { delegateId: null, assigneeId: null });
  return {
    command: "undelegate",
    issueId: issue.identifier,
    state: updatedIssue.state?.name ?? issue.state?.name ?? "Unknown",
    delegate: null,
    assignee: null,
    commentPosted,
    duplicateBlocked,
    duplicateDetails,
    commentId,
    commentUrl,
    commentCreatedAt,
    commentBodyLength,
    bodyFile,
  };
}

/**
 * linear needsHuman <id> <assignee>
 *
 * Human action is required. Idempotent — safe to call multiple times.
 * - Set status to Todo
 * - Post comment (required)
 * - Clear delegate
 * - Set assignee to specified human
 */
export async function needsHuman(
  issueId: string,
  assigneeName: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean; forceMattEscalation?: boolean }
): Promise<SemanticResult> {
  await guardMattEscalation(issueId, assigneeName, options);
  // Signal intent to the proxy so it can enforce steward-only escalation on
  // workflow tickets (Phase 2 / slice 1, design.md §11, §13).
  setProxyIntent("needs-human");
  try {
    return await executeTransition("needsHuman", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      userName: assigneeName,
      commandName: "needs-human",
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "todo",
      commentMode: "optional-with-warning",
      clearDelegate: true,
      assigneeName: (args) => args.userName,
      commentFirst: true,
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear manage <id>
 *
 * Take stewardship of a ticket that is not directly executable right now but
 * still needs an owner — typically a parent ticket whose work is in children,
 * or a ticket waiting on external state. The Linear Connector wakes the agent
 * on a cadence to re-review.
 * - Set status to Managing
 * - Set delegate to self
 * - Clear assignee
 * - Post comment (optional)
 * - Optionally write `Managing-interval: <duration>` into the description
 *   (the connector reads this to override the default 30m cadence)
 */
function upsertManagingInterval(description: string, interval: string): string {
  const marker = `Managing-interval: ${interval}`;
  const matcher = /^Managing-interval:\s*\S.*$/gm;
  if (matcher.test(description)) {
    matcher.lastIndex = 0;
    return description.replace(matcher, marker);
  }
  if (description.length === 0) return marker;
  return `${description.trimEnd()}\n\n${marker}\n`;
}

export async function manageWork(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean; interval?: string }
): Promise<SemanticResult> {
  if (options?.interval) {
    const issue = await getIssue(issueId);
    const existingDescription = issue.description ?? "";
    const nextDescription = upsertManagingInterval(existingDescription, options.interval);
    if (nextDescription !== existingDescription) {
      await updateIssue(issueId, { description: nextDescription });
    }
  }
  return executeTransition("manageWork", {
    issueId,
    comment: options?.comment,
    commentFile: options?.commentFile,
    commandName: "manage",
    forceDuplicate: options?.forceDuplicate,
  }, {
    targetState: "managing",
    commentMode: "optional",
    delegateToSelf: true,
    clearAssignee: true,
    skipIfSameState: true,
  });
}

/**
 * linear park <id>
 *
 * Intentionally deprioritize a ticket — move it to Backlog and clear ownership.
 * Use when Matt says "let's park this" or an agent reaches end-of-reflection state
 * with nothing immediately actionable.
 * - Set status to Backlog
 * - Clear delegate
 * - Clear assignee
 * - Post comment (optional)
 */
export async function parkWork(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("park");
  try {
    return await executeTransition("parkWork", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "backlog",
      commentMode: "optional",
      clearDelegate: true,
      clearAssignee: true,
    });
  } finally {
    setProxyIntent(undefined);
  }
}

// --- Dev-impl workflow semantic verbs (AI-1362) ---
// These 8 verbs map to the transitions in dev-impl.yaml. Each sets the
// x-openclaw-linear-intent header so the proxy/gate can enforce legal moves.
// request-changes and reject require a --comment (the proxy carries feedback
// via the comment body; no separate header or --category flag).

/**
 * linear accept <id>
 *
 * Accept a ticket from intake into implementation.
 * dev-impl: intake → implementation (steward action)
 */
export async function accept(
  issueId: string,
  target?: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyTarget(target);
  setProxyIntent("accept");
  try {
    return await executeTransition("accept", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
      userName: target,
    }, {
      targetState: "doing",
      commentMode: "optional",
      addLabels: ["state:implementation"],
      removeLabelsIfPresent: ["state:intake"],
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear submit <id>
 *
 * Submit implementation work for code review.
 * dev-impl: implementation → code-review (dev action)
 */
export async function submit(
  issueId: string,
  target?: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyTarget(target);
  setProxyIntent("submit");
  try {
    return await executeTransition("submit", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
      userName: target,
    }, {
      targetState: "thinking",
      commentMode: "optional",
      addLabels: ["state:code-review"],
      removeLabelsIfPresent: ["state:implementation"],
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear approve <id>
 *
 * Approve after code review, advancing to deployment.
 * dev-impl: code-review → deployment (code-review action)
 */
export async function approve(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("approve");
  try {
    return await executeTransition("approve", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "doing",
      commentMode: "optional",
      addLabels: ["state:deployment"],
      removeLabelsIfPresent: ["state:code-review"],
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear request-changes <id>
 *
 * Request changes during code review, sending back to implementation.
 * dev-impl: code-review → implementation (code-review action)
 * Requires --comment (feedback must be carried).
 */
export async function requestChanges(
  issueId: string,
  options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  const body = await (async () => {
    if (options.commentFile) {
      try {
        return (await fs.readFile(options.commentFile, "utf8")).trim();
      } catch {
        return "";
      }
    }
    return options.comment?.trim() ?? "";
  })();
  if (!body) {
    throw new Error("request-changes requires --comment <text>.");
  }
  setProxyIntent("request-changes");
  try {
    return await executeTransition("requestChanges", {
      issueId,
      comment: body,
      forceDuplicate: options.forceDuplicate,
    }, {
      targetState: "doing",
      commentMode: "required",
      addLabels: ["state:implementation"],
      removeLabelsIfPresent: ["state:code-review"],
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear deploy <id>
 *
 * Deploy after approval, completing the workflow.
 * dev-impl: deployment → done (deployment action, requires deploy:execute capability)
 */
export async function deploy(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("deploy");
  try {
    return await executeTransition("deploy", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "done",
      commentMode: "optional",
      clearDelegate: true,
      clearAssignee: true,
      removeLabelsIfPresent: ["state:deployment"],
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear reject <id>
 *
 * Reject during deployment, sending back to implementation.
 * dev-impl: deployment → implementation (deployment action)
 * Requires --comment (feedback must be carried).
 */
export async function reject(
  issueId: string,
  options: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  const body = await (async () => {
    if (options.commentFile) {
      try {
        return (await fs.readFile(options.commentFile, "utf8")).trim();
      } catch {
        return "";
      }
    }
    return options.comment?.trim() ?? "";
  })();
  if (!body) {
    throw new Error("reject requires --comment <text>.");
  }
  setProxyIntent("reject");
  try {
    return await executeTransition("reject", {
      issueId,
      comment: body,
      forceDuplicate: options.forceDuplicate,
    }, {
      targetState: "doing",
      commentMode: "required",
      addLabels: ["state:implementation"],
      removeLabelsIfPresent: ["state:deployment"],
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear escape <id>
 *
 * Break-glass: steward escapes the ticket out of the workflow.
 * dev-impl: any state → escape terminal (steward action)
 */
export async function escape(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("escape");
  try {
    return await executeTransition("escape", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "backlog",
      commentMode: "optional",
      clearDelegate: true,
      clearAssignee: true,
      removeLabelsIfPresent: ["state:intake", "state:implementation", "state:code-review", "state:deployment"],
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear demote <id>
 *
 * Demote a ticket out of the dev-impl workflow entirely.
 * dev-impl: intake → __ad_hoc__ (steward action, ticket leaves workflow)
 */
export async function demote(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("demote");
  try {
    return await executeTransition("demote", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "backlog",
      commentMode: "optional",
      clearDelegate: true,
      clearAssignee: true,
      removeLabelsIfPresent: ["state:intake", "wf:dev-impl"],
    });
  } finally {
    setProxyIntent(undefined);
  }
}
