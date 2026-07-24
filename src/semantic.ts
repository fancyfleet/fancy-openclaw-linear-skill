import fs from "node:fs/promises";

import {
  executeTransition,
  findRecentDuplicate,
  checkCommentRateLimit,
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
import { setProxyIntent, setProxyTarget, setProxyCodeArtifact, setProxySubstitutionReason, setProxyBreakGlass } from "./client";
import { getComments, getIssueHistory } from "./boards";
import { getSelfUser } from "./auth";
import { addComment, getIssue, resolveUserWithHints, updateIssue } from "./issues";
import { createDuplicateRelation } from "./relations";
import { findStateByType } from "./states";
import { resolveLabelIds } from "./labels";
import { buildArtifactMarker, formatCodeArtifact, parseCodeArtifact } from "./artifact";
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
  trashed?: boolean;
  archivedAt?: string | null;
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
  /** True when the per-issue per-agent comment rate limit was exceeded. */
  rateLimitBlocked: boolean;
  rateLimitDetails: { recentCount: number; maxAllowed: number; windowSeconds: number } | null;
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
    trashed: issue.trashed,
    archivedAt: issue.archivedAt,
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
    // Delegate-only ownership: prevents concurrent-grab where both delegate and assignee
    // run consider-work simultaneously and stomp each other's transitions (AI-1394).
    requireSelfDelegated: !options?.force,
    // Advancement guard: if the ticket is already past "thinking" in the workflow
    // (higher state position), return a no-op instead of reverting the state. Stops a
    // stale consider-work wake from silently reverting an already-advanced ticket (AI-1394).
    skipIfStatePositionAheadOfTarget: !options?.force,
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
  setProxyIntent("refuse-work");
  try {
    return await executeTransition("refuseWork", {
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
  } finally {
    setProxyIntent(undefined);
  }
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
 *
 * AI-2479 — with codeArtifact: declares the `<branch>@<sha>` this handoff is
 * about. The declaration is recorded in the handoff comment as an HTML marker
 * and sent to the proxy, which refuses a handoff that silently declares an
 * artifact other than the one the caller was handed. substitutionReason is the
 * sanctioned, non-silent path for a legitimate swap.
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
    codeArtifact?: string;
    substitutionReason?: string;
  }
): Promise<SemanticResult> {
  // Parse before guardMattEscalation and before any mutation: a malformed
  // operand must fail loudly and inertly, never half-apply a handoff.
  const artifact = options?.codeArtifact ? parseCodeArtifact(options.codeArtifact) : undefined;
  if (options?.substitutionReason && !artifact) {
    throw new Error(
      "--substitution-reason declares why the artifact differs from the one you were handed, " +
      "so it requires --code-artifact <branch>@<sha>."
    );
  }

  await guardMattEscalation(issueId, delegateName, options);

  let comment = options?.comment;
  let commentFile = options?.commentFile;
  const issue = await getIssue(issueId);

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

  // AI-2479: record the declared artifact in the comment body, so the record
  // lives in the ticket timeline rather than in connector process memory — a
  // handoff and its review can be days apart, and neither connector store
  // survives a restart.
  //
  // Appended BEFORE near-duplicate detection deliberately. Two handoffs whose
  // text AND artifact match are still true duplicates and should still collapse
  // (the surviving earlier comment already carries the identical marker, so the
  // record is not lost); two handoffs declaring DIFFERENT artifacts now differ in
  // body and both post, which is exactly the history the guard needs to read.
  if (artifact) {
    if (commentFile) {
      comment = (await fs.readFile(commentFile, "utf8")).trim();
      commentFile = undefined;
    }
    // Resolve the recipient so the marker records WHO owes the next disclosure.
    // executeTransition resolves this name again; the duplicate read is worth it
    // to keep the marker addressed, and it only runs when --code-artifact is
    // passed, so a handoff without a declaration makes no extra call and behaves
    // exactly as it did before. Resolving here also fails loudly on a bad name
    // before the comment is posted, matching parseCodeArtifact above.
    const recipient = await resolveUserWithHints(delegateName, "handoff-work");
    const body = comment?.trim() || `Handing off. Artifact: ${formatCodeArtifact(artifact)}`;
    comment = `${body}\n\n${buildArtifactMarker(artifact, recipient.id)}`;
  }

  // AI-1494: a generic handoff on a live wf:dev-impl ticket is an OWNER change,
  // not a STATE change. The previous behavior reset the native column to "To Do"
  // and stripped the `state:*` projection label, mis-rendering the board and
  // tripping the p65 "no state:* label" wedge. Preserve the state projection:
  // change only the delegate, leave the native column and the active state:*
  // label untouched. We send delegateId-only (no stateId, no assigneeId, no
  // labelIds) so the connector proxy's raw-mutation interception passes it
  // through as a benign owner change rather than blocking it as a bypass.
  const DEV_IMPL_STATE_TARGET: Record<string, string> = {
    "state:intake": "todo",
    "state:implementation": "doing",
    "state:code-review": "thinking",
    "state:merge": "doing",
    "state:deploy": "doing",
  };
  const activeStateLabel = (issue.labels ?? [])
    .map((l) => l.name.toLowerCase())
    .find((n) => n in DEV_IMPL_STATE_TARGET);

  // AI-2595: set proxy intent "handoff" on dev-impl governed tickets. The dev-impl
  // workflow now declares a `handoff` self-loop transition from `implementation`
  // state (AI-2595 AC2 + INF-93), so the intent routes through checkWorkflowRules
  // → applyStateTransition, where the self-loop delegate-semantics code writes the
  // delegate atomically (data-loss-safe, label-preserving). Non-dev-impl handoffs
  // remain intent-free (the connector's raw-mutation interception handles them).
  if (artifact) setProxyCodeArtifact(formatCodeArtifact(artifact));
  if (options?.substitutionReason) setProxySubstitutionReason(options.substitutionReason);
  try {
  if (activeStateLabel && !options?.reviewHandoff) {
    setProxyIntent("handoff");
    return await executeTransition("handoffWork", {
      issueId,
      comment,
      commentFile,
      userName: delegateName,
      commandName: "handoff-work",
      forceDuplicate: options?.forceDuplicate,
    }, {
      // targetState resolves the current native state (a no-op for the column);
      // omitStateId suppresses the write so the proxy stays the sole native writer.
      targetState: DEV_IMPL_STATE_TARGET[activeStateLabel],
      commentMode: "optional-with-warning",
      delegateName: (args) => args.userName,
      requireAppUserDelegate: true,
      commentFirst: true,
      omitStateId: true,
      // AI-2595: self-loop (source === destination) — state:* labels don't change,
      // so skip the post-transition label-verify check. The delegate persistence
      // check (executeTransition step 11) still verifies the write landed.
      skipPostTransitionVerify: true,
      // Intentionally NOT clearing assignee and NOT stripping the state:* label:
      // sending assigneeId/labelIds would trip the proxy's raw-mutation block and
      // dropping the label is exactly the regression this fixes.
    }).finally(() => { setProxyIntent(undefined); });
  }

  return await executeTransition("handoffWork", {
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
    requireAppUserDelegate: true,
    clearAssignee: true,
    commentFirst: true,
    addLabels: options?.reviewHandoff ? [AGENT_REVIEW_LABEL] : undefined,
    // Strip any active dev-impl state:* labels when doing a generic handoff to
    // prevent column/label divergence (state=To Do but label=state:implementation).
    removeLabelsIfPresent: ["state:intake", "state:implementation", "state:code-review", "state:merge", "state:deploy"],
  });
  } finally {
    setProxyCodeArtifact(undefined);
    setProxySubstitutionReason(undefined);
  }
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
  rateLimitBlocked: boolean;
  rateLimitDetails: { recentCount: number; maxAllowed: number; windowSeconds: number } | null;
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
  // Rate limit check (independent of similarity)
  const rateHit = options.forceDuplicate ? null : await checkCommentRateLimit(issue.id);
  if (rateHit) {
    return {
      issueId: issue.identifier,
      commentId: null,
      commentPosted: false,
      duplicateBlocked: false,
      duplicateDetails: null,
      rateLimitBlocked: true,
      rateLimitDetails: { recentCount: rateHit.recentCount, maxAllowed: rateHit.maxAllowed, windowSeconds: rateHit.windowSeconds },
      commentUrl: null,
      commentCreatedAt: null,
      commentBodyLength: null,
      bodyFile: null,
    };
  }
  const dup: DuplicateMatch | null = options.forceDuplicate ? null : await findRecentDuplicate(issue.id, body);
  if (dup) {
    return {
      issueId: issue.identifier,
      commentId: dup.id,
      commentPosted: false,
      duplicateBlocked: true,
      duplicateDetails: { existingCommentId: dup.id, similarity: dup.similarity, ageSeconds: dup.ageSeconds },
      rateLimitBlocked: false,
      rateLimitDetails: null,
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
    rateLimitBlocked: false,
    rateLimitDetails: null,
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
  let rateLimitBlocked = false;
  let rateLimitDetails: SemanticResult["rateLimitDetails"] = null;
  let duplicateDetails: SemanticResult["duplicateDetails"] = null;
  let commentId: string | null = null;
  let commentUrl: string | null = null;
  let commentCreatedAt: string | null = null;
  let commentBodyLength: number | null = null;
  let bodyFile: string | null = null;

  if (body) {
    // Rate limit check (independent of similarity)
    const rateHit = options?.forceDuplicate ? null : await checkCommentRateLimit(issue.id);
    if (rateHit) {
      rateLimitBlocked = true;
      rateLimitDetails = { recentCount: rateHit.recentCount, maxAllowed: rateHit.maxAllowed, windowSeconds: rateHit.windowSeconds };
    } else {
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
  }

  const updatedIssue = await updateIssue(issueId, { delegateId: null, assigneeId: null });

  // AI-2050: `undelegate` is the remedy clearStrandedDelegate points at, so above all
  // it must not claim a clear it did not achieve. Reporting `delegate: null`
  // unconditionally is how a stranded delegate stays invisible: the agent runs the
  // remedy, sees success, and the ticket keeps re-entering its queue.
  if (updatedIssue.delegate) {
    process.stderr.write(
      `Warning: undelegate did not clear the delegate on ${issue.identifier} — it is still ` +
      `"${updatedIssue.delegate.name}". 'linear queue' serves tickets by delegate, so this ticket ` +
      `will keep being handed back to ${updatedIssue.delegate.name} on every heartbeat.\n`
    );
  }

  return {
    command: "undelegate",
    issueId: issue.identifier,
    state: updatedIssue.state?.name ?? issue.state?.name ?? "Unknown",
    delegate: updatedIssue.delegate?.name ?? null,
    assignee: updatedIssue.assignee?.name ?? null,
    commentPosted,
    duplicateBlocked,
    rateLimitBlocked,
    rateLimitDetails,
    duplicateDetails,
    commentId,
    commentUrl,
    commentCreatedAt,
    commentBodyLength,
    bodyFile,
  };
}

/**
 * An escalation whose delegate survived is worse than no escalation: `linear queue`
 * serves tickets by *delegate*, so the escalating agent keeps being handed a ticket
 * that is, correctly, blocked on a human. AI-2048 produced four near-identical
 * "still blocked" comments in 90 minutes this way.
 *
 * The transition already asks for `delegateId: null`, but the connector proxy strips
 * null delegate/assignee fields from every intent-bearing issueUpdate (AI-1857), and
 * its `applyStateTransition` no-ops on ad-hoc tickets — so nothing clears it. Re-issue
 * the clear as a plain, intent-free mutation: that is the exact shape `undelegate`
 * uses, and the proxy forwards it untouched on ad-hoc tickets.
 *
 * On a *governed* ticket the proxy legitimately refuses raw delegate clears. There we
 * surface the stranded delegate and the remedy rather than throwing — the escalation
 * itself (assignee + comment) has already landed, and failing here would strand it.
 */
async function clearStrandedDelegate(issueId: string, result: SemanticResult): Promise<SemanticResult> {
  const stranded = result.delegate;
  if (!stranded) return result;

  let reason = "the delegate write did not persist";
  try {
    const updated = await updateIssue(issueId, { delegateId: null });
    if (!updated.delegate) {
      return { ...result, delegate: null };
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  process.stderr.write(
    `Warning: ${result.issueId} is assigned to ${result.assignee ?? "a human"}, but "${stranded}" is STILL its delegate. ` +
    `'linear queue' serves tickets by delegate, so this ticket will be handed back to ${stranded} on every heartbeat ` +
    `even though it is blocked on a human.\n` +
    `  Reason the clear failed: ${reason}\n` +
    `  Remedy:\n` +
    `    linear undelegate ${result.issueId}\n` +
    `    linear needs-human ${result.issueId} "${result.assignee ?? "<human>"}"\n`
  );
  return result;
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
  let result: SemanticResult;
  try {
    result = await executeTransition("needsHuman", {
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
    // Cleared before the corrective write below: an intent header on that mutation
    // is exactly what makes the proxy strip the delegate clear (AI-1857).
    setProxyIntent(undefined);
  }

  return clearStrandedDelegate(issueId, result);
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

export interface DuplicateResult extends SemanticResult {
  /** Identifier of the canonical ticket this one was consolidated into. */
  canonicalId: string;
  /**
   * True when the native Linear `duplicate` relation exists. Always true on a
   * successful return: the relation is now a precondition of the state move
   * (AI-2500), so a failed relation write throws instead of returning false.
   */
  relationCreated: boolean;
  /** Retained for output-shape compatibility; always null (a relation failure throws). */
  relationError: string | null;
}

/**
 * linear duplicate <id> <canonical-id>
 *
 * Consolidate an existing ticket into a canonical one: move it to the team's
 * `duplicate`-type state, clear ownership, and link it to the canonical ticket.
 *
 * Exists because neither terminal verb could express "settled, never do this"
 * (AI-2445). `complete` → Done counted no-work-performed tickets as delivery;
 * `park` → Backlog reads as *later*, not *never*, so consolidated duplicates got
 * picked back up and regenerated the loop this verb ends.
 */
export async function duplicate(
  issueId: string,
  canonicalId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<DuplicateResult> {
  // Validate the canonical ticket BEFORE any mutation: a refusal must leave the
  // board untouched, and the checks below are the whole point of the verb.
  const canonical = await getIssue(canonicalId);
  const target = await getIssue(issueId);

  if (canonical.id === target.id) {
    throw new Error(
      `Cannot mark ${target.identifier} as a duplicate of itself. ` +
        `Pass the canonical ticket that survives consolidation as the second argument.`
    );
  }

  // AC3: consolidating into a ticket that is itself dead is the "consolidated into
  // a blocked ticket" failure — the duplicate chain points at something nobody will
  // ever work, so the underlying need silently evaporates. Refuse mechanically.
  const canonicalType = (canonical.state?.type ?? "").toLowerCase();
  if (canonicalType === "duplicate" || canonicalType === "canceled") {
    throw new Error(
      `Cannot consolidate ${target.identifier} into ${canonical.identifier}: ` +
        `${canonical.identifier} is itself in a dead state ("${canonical.state?.name}", type: ${canonicalType}). ` +
        `Consolidating into a dead ticket buries the need instead of tracking it. ` +
        `Find the live canonical ticket — if ${canonical.identifier} was itself marked duplicate, ` +
        `follow its duplicate relation to the ticket that survived — and point at that instead.`
    );
  }

  // Resolve the duplicate state BEFORE writing anything. The relation has to be
  // created first (below), but on a team with no duplicate-type column the move
  // can never complete — and a relation written first would then be stray litter
  // on a board that cannot finish the consolidation. executeTransition resolves
  // this again internally; the second call is served from the states cache.
  const teamId = target.team?.id;
  if (!teamId) {
    throw new Error(`Issue ${target.identifier} has no team — cannot resolve a duplicate state.`);
  }
  await findStateByType(teamId, "duplicate");

  // Linear refuses a move into a duplicate-type state unless the relation already
  // exists ("Issues can only be moved to a duplicate state when a duplicate issue
  // relation exists"), so the link is a precondition of the transition, not a
  // follow-up to it. Ordering these the other way round is AI-2500: the verb threw
  // on every invocation from the day it shipped, because the mocked suite could not
  // see a constraint that only the live API enforces.
  await createDuplicateRelation(target.id, canonical.id);

  setProxyIntent("duplicate");
  let result: TransitionResult;
  try {
    result = await executeTransition("duplicate", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      // Resolved by type, not name: teams name this column freely, and a missing
      // duplicate-type state must fail loudly rather than fall back to Done (AC1/AC4).
      targetStateType: "duplicate",
      commentMode: "optional",
      // Terminal: nothing should dispatch this ticket again (AC2).
      clearDelegate: true,
      clearAssignee: true,
    });
  } catch (err) {
    // The relation landed and the state did not. Say so rather than letting a bare
    // transition error imply nothing happened: the link is real and visible in
    // `linear relations`. Retrying the verb is safe — issueRelationCreate is
    // idempotent for an identical duplicate relation (verified against the live
    // API), so the retry re-uses the existing link and re-attempts only the move.
    process.stderr.write(
      `Warning: the duplicate relation from ${target.identifier} to ${canonical.identifier} was ` +
        `created, but the move into the duplicate state failed. The relation stands and is visible ` +
        `via 'linear relations ${target.identifier}'. Re-running this command is safe.\n`
    );
    throw err;
  } finally {
    setProxyIntent(undefined);
  }

  return { ...result, canonicalId: canonical.identifier, relationCreated: true, relationError: null };
}

/**
 * linear cancel <id> --comment <reason>
 *
 * Retire a ticket that will never be worked: move it to the team's `canceled`-type
 * state (named "Invalid" on the AI team) and clear ownership.
 *
 * The won't-do sibling of `duplicate` (AI-2445). Same gap, same workaround: without
 * it, a ticket that should never be picked up could only go to Done (counts as
 * delivery) or Backlog (reads as *later*, not *never*, so it gets picked back up).
 *
 * Named for the state *type*, not the AI team's column name: resolution is by type
 * (AC1), so a verb called `invalid` would bake one team's label into a fleet-wide
 * command that lands elsewhere on teams naming the column differently.
 *
 * The comment is required, unlike `duplicate`. A duplicate carries its own
 * explanation — the canonical ticket it points at. A cancellation points at nothing,
 * so with no reason recorded the ticket becomes a dead end that the next auditor has
 * to re-litigate from scratch. That re-litigation is the loop this ticket set out to
 * end.
 */
export async function cancel(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("cancel");
  try {
    return await executeTransition("cancel", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      // Resolved by type, never name; a missing canceled-type state fails loudly
      // rather than falling back to Done (AC1/AC4).
      targetStateType: "canceled",
      commentMode: "required",
      // Terminal: nothing should dispatch this ticket again (AC2).
      clearDelegate: true,
      clearAssignee: true,
    });
  } finally {
    setProxyIntent(undefined);
  }
}

// --- Dev-impl workflow semantic verbs (AI-1362; v8 verbs added 2026-06-11) ---
// These verbs map to the transitions in dev-impl.yaml. Each sets the
// x-openclaw-linear-intent header so the proxy/gate can enforce legal moves.
// request-changes, reject, and ac-fail require a --comment (the proxy carries
// feedback via the comment body; no separate header or --category flag).

// v8 dev-impl pipeline state labels. Each governed verb adds its destination's
// state:* label and strips every OTHER pipeline label, so a ticket never carries
// two state:* labels at once. The connector proxy reconciles the authoritative
// label from the workflow def; the CLI keeps the projection consistent in its
// own forwarded mutation. removeLabelsIfPresent is filtered to labels actually
// on the issue before any write (state-machine.ts), so listing all others is safe.
const DEV_IMPL_STATE_LABELS = [
  "state:intake",
  "state:write-tests",
  "state:implementation",
  "state:code-review",
  "state:merge",
  "state:deploy",
  "state:ac-validate",
] as const;

function otherStateLabels(dest: string): string[] {
  return DEV_IMPL_STATE_LABELS.filter((l) => l !== dest);
}

/**
 * linear accept <id>
 *
 * Accept a ticket from intake into write-tests (v8).
 * dev-impl: intake → write-tests (steward action). The test-author role is a
 * singleton (TestDrivenDevelopmentAgent), so the connector auto-assigns the
 * delegate; a target is normally omitted.
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
      targetState: "todo",
      commentMode: "optional",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear tests-ready <id> <target>
 *
 * Failing tests are written and red; hand to an implementer.
 * dev-impl: write-tests → implementation (test-author action). The dev role is
 * multi-body (felix/noah/sage/igor), so a target is required; the connector
 * validates it against the dev role.
 */
export async function testsReady(
  issueId: string,
  target?: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyTarget(target);
  setProxyIntent("tests-ready");
  try {
    return await executeTransition("testsReady", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
      userName: target,
    }, {
      targetState: "doing",
      commentMode: "optional",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear brief-ready <id>
 *
 * Brief is written and ready; hand off to the image artist.
 * vocab-image: briefing → generating
 */
export async function briefReady(
  issueId: string,
  target?: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyTarget(target);
  setProxyIntent("brief-ready");
  try {
    return await executeTransition("briefReady", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
      userName: target,
    }, {
      targetState: "todo",
      commentMode: "required",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear filed <id>
 *
 * Approved image filed to the illustrations folder; close the ticket.
 * vocab-image: filing → done
 */
export async function filed(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("filed");
  try {
    return await executeTransition("filed", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "done",
      commentMode: "required",
      omitStateId: true,
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear continue-workflow <id>
 *
 * Generic "move forward" command. The proxy resolves this to the actual workflow
 * transition command (e.g. brief-ready, submit, approve, filed) based on the ticket's
 * current state and the `generic: continue` tag in the workflow definition.
 *
 * Requires a comment. Named commands (brief-ready, submit, etc.) remain as aliases.
 */
export async function continueWorkflow(
  issueId: string,
  target?: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyTarget(target);
  setProxyIntent("continue-workflow");
  try {
    return await executeTransition("continue-workflow", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
      userName: target,
    }, {
      commentMode: "required",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear request-revision <id>
 *
 * Generic "send back" command. The proxy resolves this to the actual workflow
 * transition command (e.g. request-changes) based on the ticket's current state
 * and the `generic: revision` tag in the workflow definition.
 *
 * Requires a comment explaining what needs to change. Named commands remain as aliases.
 */
export async function requestRevision(
  issueId: string,
  target?: string,
  options?: { comment?: string; commentFile?: string; feedbackCategory?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyTarget(target);
  setProxyIntent("request-revision");
  try {
    return await executeTransition("request-revision", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      commentMode: "required",
      omitStateId: true,
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
      omitStateId: true,
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
 * Approve after code review, advancing to merge.
 * dev-impl: code-review → merge (code-review action)
 * AI-1872: previously routed to `deployment`; now routes to `merge`.
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
      omitStateId: true,
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
  options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; target?: string }
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
  const target = options.target;
  setProxyTarget(target);
  setProxyIntent("request-changes");
  try {
    return await executeTransition("requestChanges", {
      issueId,
      comment: body,
      forceDuplicate: options.forceDuplicate,
      userName: target,
    }, {
      targetState: "doing",
      commentMode: "required",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear deploy <id> — DEPRECATED (AI-1872)
 *
 * The `deployment` state was split into `merge` + `deploy` states with generic
 * verbs only. Use `continue-workflow` at each state instead.
 */
export async function deploy(_issueId: string): Promise<never> {
  throw new Error(
    "'deploy' is deprecated (AI-1872): the deployment state was split into merge + deploy states. " +
    "Use 'continue-workflow' to advance through both states."
  );
}

/**
 * linear handoff-host-deploy <id> — DEPRECATED (AI-1872)
 *
 * The `deployment` + `host-deploy` states were replaced by `merge` + `deploy`
 * states with generic verbs only. Use `continue-workflow` to advance.
 */
export async function handoffHostDeploy(_issueId: string): Promise<never> {
  throw new Error(
    "'handoff-host-deploy' is deprecated (AI-1872): the host-deploy state was replaced by the deploy state. " +
    "Use 'continue-workflow' to advance from merge → deploy → ac-validate."
  );
}

/**
 * linear host-deployed <id> — DEPRECATED (AI-1872)
 *
 * The `host-deploy` state was replaced by the `deploy` state with generic verbs.
 * Use `continue-workflow` to advance from deploy → ac-validate.
 */
export async function hostDeployed(_issueId: string): Promise<never> {
  throw new Error(
    "'host-deployed' is deprecated (AI-1872): the host-deploy state was replaced by the deploy state. " +
    "Use 'continue-workflow' to advance from deploy → ac-validate."
  );
}

/**
 * linear validated <id>
 *
 * The deployed artifact satisfies the acceptance criteria — close the ticket (v8).
 * dev-impl: ac-validate → done (steward action, terminal). Ownership is cleared.
 */
export async function validated(
  issueId: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean }
): Promise<SemanticResult> {
  setProxyIntent("validated");
  try {
    return await executeTransition("validated", {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
    }, {
      targetState: "done",
      commentMode: "optional",
      omitStateId: true,
      clearDelegate: true,
      clearAssignee: true,
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear ac-fail <id>
 *
 * The deployed artifact does NOT satisfy the acceptance criteria — send back to
 * implementation (v8). dev-impl: ac-validate → implementation (steward action).
 * Requires --comment (feedback must be carried). Target defaults to the prior
 * implementer (the connector pre-fills it); pass --target to override.
 */
export async function acFail(
  issueId: string,
  options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; target?: string }
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
    throw new Error("ac-fail requires --comment <text>.");
  }
  const target = options.target;
  setProxyTarget(target);
  setProxyIntent("ac-fail");
  try {
    return await executeTransition("acFail", {
      issueId,
      comment: body,
      forceDuplicate: options.forceDuplicate,
      userName: target,
    }, {
      targetState: "doing",
      commentMode: "required",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
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
  options: { comment?: string; commentFile?: string; forceDuplicate?: boolean; target?: string }
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
  const target = options.target;
  setProxyTarget(target);
  setProxyIntent("reject");
  try {
    return await executeTransition("reject", {
      issueId,
      comment: body,
      forceDuplicate: options.forceDuplicate,
      userName: target,
    }, {
      targetState: "doing",
      commentMode: "required",
      omitStateId: true,
      ...(target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
  }
}

/**
 * linear steward-takeover <id>
 *
 * Sanctioned steward closure path (AC1–AC4, AI-1596). When a deployment-stage
 * delegate is absent, a steward (Managing) can take over without break-glass.
 * - Reassigns delegate to self regardless of who the current delegate is
 * - Does NOT change state or labels (delegate-only mutation)
 * - Posts optional comment
 * - Sets proxy intent "steward-takeover" so the connector can surface it as
 *   an actionable path in stuck-delegate alerts (AC3)
 */
export async function stewardTakeover(
  issueId: string,
  options?: { comment?: string }
): Promise<SemanticResult> {
  setProxyIntent("steward-takeover");
  try {
    const issue = await getIssue(issueId);
    const self = await getSelfUser();

    let commentPosted = false;
    let commentId: string | null = null;
    let commentUrl: string | null = null;
    let commentCreatedAt: string | null = null;
    let commentBodyLength: number | null = null;

    if (options?.comment) {
      const cr = await addComment(issueId, options.comment);
      commentPosted = true;
      commentId = cr.commentId;
      commentUrl = cr.commentUrl;
      commentCreatedAt = cr.commentCreatedAt;
      commentBodyLength = cr.commentBodyLength;
    }

    // Delegate-only mutation — no stateId, no label changes (AC1)
    const updatedIssue = await updateIssue(issueId, { delegateId: self.id });

    return {
      command: "stewardTakeover",
      issueId: issue.identifier,
      state: updatedIssue.state?.name ?? issue.state?.name ?? "Unknown",
      delegate: self.name,
      assignee: updatedIssue.assignee ? (updatedIssue.assignee as { name: string }).name : null,
      commentPosted,
      duplicateBlocked: false,
      duplicateDetails: null,
      rateLimitBlocked: false,
      rateLimitDetails: null,
      commentId,
      commentUrl,
      commentCreatedAt,
      commentBodyLength,
      bodyFile: null,
    };
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear escape <id>
 *
 * Break-glass: re-enters the ticket at workflow intake (any state → intake).
 * Clears delegate, assignee, and state labels; keeps wf:* label.
 * The connector applies state:intake and re-delegates to the steward.
 * dev-impl: any state → intake (steward action)
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
      // escape re-enters at intake (native Todo). The connector's break_glass.to
      // is "intake", so applyStateTransition stamps state:intake and delegates
      // to the steward. omitStateId skips the CLI's own label write (connector
      // handles it); clearDelegate/clearAssignee wipe the prior owner.
      targetState: "todo",
      commentMode: "optional",
      omitStateId: true,
      clearDelegate: true,
      clearAssignee: true,
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
      omitStateId: true,
      clearDelegate: true,
      clearAssignee: true,
    });
  } finally {
    setProxyIntent(undefined);
  }
}

/**
 * linear transition <id> <move>
 *
 * Generic governed transition: sends any named workflow move through the proxy
 * (`X-Openclaw-Linear-Intent: <move>`) without needing a dedicated CLI verb.
 * The proxy/connector remains the sole authority on whether the move is legal
 * in the ticket's current state, and its applyStateTransition performs all
 * state/label/delegate effects (omitStateId — the CLI writes no state itself).
 *
 * INF-204: workflow moves like sprint-spawner `hold` / `start-cycle` existed in
 * the connector but had no CLI wrapper, so dispatch messages advertised
 * commands agents could not run and governed tickets got stuck re-dispatching.
 * This verb closes that class of gap: new connector moves need no CLI release.
 *
 * INF-482: added --break-glass support for emergency recovery.
 */
const MOVE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function transition(
  issueId: string,
  move: string,
  options?: { comment?: string; commentFile?: string; forceDuplicate?: boolean; target?: string; breakGlass?: boolean }
): Promise<SemanticResult> {
  if (!MOVE_NAME_PATTERN.test(move)) {
    throw new Error(
      `Invalid move name "${move}": expected a lowercase kebab-case workflow move (e.g. hold, start-cycle).`
    );
  }
  if (!process.env.LINEAR_PROXY_URL) {
    throw new Error(
      `linear transition requires the governed proxy (LINEAR_PROXY_URL is not set). ` +
      `Without the proxy there is no workflow engine to resolve "${move}", and the CLI ` +
      `will not guess state effects for arbitrary moves.`
    );
  }
  setProxyTarget(options?.target);
  setProxyIntent(move);
  if (options?.breakGlass) {
    setProxyBreakGlass(true);
  }
  try {
    return await executeTransition(move, {
      issueId,
      comment: options?.comment,
      commentFile: options?.commentFile,
      forceDuplicate: options?.forceDuplicate,
      userName: options?.target,
    }, {
      commentMode: "optional",
      omitStateId: true,
      ...(options?.target ? { delegateName: (args: TransitionArgs) => args.userName } : {}),
    });
  } finally {
    setProxyIntent(undefined);
    setProxyTarget(undefined);
    setProxyBreakGlass(undefined);
  }
}
