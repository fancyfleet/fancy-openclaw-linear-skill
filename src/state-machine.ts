import fs from "node:fs/promises";

import { getSelfUser } from "./auth";
import { getComments, getIssueHistory } from "./boards";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "./issues";
import { resolveLabelIds } from "./labels";
import { findSemanticState } from "./states";
import { ObserveResult, SemanticResult, historyToTimelineEvents } from "./semantic";

// --- Comment deduplication ---

/**
 * Rolling window for near-duplicate comment suppression.
 * Configurable via LINEAR_COMMENT_DEDUP_WINDOW_SECONDS env var.
 */
const COMMENT_DEDUP_WINDOW_SECONDS = parseInt(process.env.LINEAR_COMMENT_DEDUP_WINDOW_SECONDS ?? "600", 10);

/**
 * Minimum word-overlap Jaccard similarity to trigger dedup suppression.
 * Configurable via LINEAR_COMMENT_SIMILARITY_THRESHOLD env var (0–1).
 */
const COMMENT_SIMILARITY_THRESHOLD = parseFloat(process.env.LINEAR_COMMENT_SIMILARITY_THRESHOLD ?? "0.80");

/**
 * Maximum comments a single agent may post on one issue within the rate-limit window.
 * Configurable via LINEAR_COMMENT_RATE_LIMIT_MAX env var.
 */
const COMMENT_RATE_LIMIT_MAX = parseInt(process.env.LINEAR_COMMENT_RATE_LIMIT_MAX ?? "3", 10);

/**
 * Rolling window (seconds) for the per-issue per-agent comment rate limit.
 * Configurable via LINEAR_COMMENT_RATE_LIMIT_WINDOW_SECONDS env var.
 */
const COMMENT_RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.LINEAR_COMMENT_RATE_LIMIT_WINDOW_SECONDS ?? "300", 10);

/**
 * Strip HTML/Prosemirror markup for body comparison.
 */
function stripMarkup(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, "").replace(/\s+/g, " ").trim();
}

/**
 * Word-overlap Jaccard similarity between two strings.
 * Returns a value in [0, 1]: 1.0 = identical word sets, 0.0 = disjoint.
 */
export function computeWordSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    stripMarkup(s)
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      .filter(Boolean)
  );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Check whether a comment with the given body would be a near-duplicate of
 * any comment by the same author within the dedup window. Returns the most
 * recent matching comment if found, null otherwise.
 * Best-effort: failures return null (proceed with post).
 */
export interface DuplicateMatch {
  id: string;
  createdAt: string;
  similarity: number;
  ageSeconds: number;
}

/**
 * Check whether the authenticated user has exceeded the per-issue comment rate
 * limit within the rolling window. Returns the count of recent self-comments if
 * over the limit, null otherwise. Independent of comment body similarity.
 * Best-effort: failures return null (proceed with post).
 */
export interface RateLimitResult {
  /** Number of comments by self on this issue within the rate-limit window */
  recentCount: number;
  /** Max allowed within the window */
  maxAllowed: number;
  /** Window in seconds */
  windowSeconds: number;
  /** ISO timestamp of the most recent self-comment within the window */
  mostRecentAt: string;
}

export async function checkCommentRateLimit(
  issueId: string
): Promise<RateLimitResult | null> {
  try {
    const self = await getSelfUser();
    const comments = await getComments(issueId, false);
    const cutoffMs = COMMENT_RATE_LIMIT_WINDOW_SECONDS * 1000;
    const now = Date.now();
    let recentCount = 0;
    let mostRecentAt = "";
    // Count self-comments within the window (comments sorted ascending)
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (!c.createdAt || !c.user) continue;
      const ageMs = now - new Date(c.createdAt).getTime();
      if (ageMs > cutoffMs) break;
      if (c.user.id !== self.id) continue;
      recentCount++;
      if (!mostRecentAt) mostRecentAt = c.createdAt;
    }
    if (recentCount >= COMMENT_RATE_LIMIT_MAX) {
      process.stderr.write(
        `RATE_LIMIT_BLOCKED: ${recentCount} comments in ${COMMENT_RATE_LIMIT_WINDOW_SECONDS}s window (max ${COMMENT_RATE_LIMIT_MAX})\n`
      );
      return { recentCount, maxAllowed: COMMENT_RATE_LIMIT_MAX, windowSeconds: COMMENT_RATE_LIMIT_WINDOW_SECONDS, mostRecentAt };
    }
  } catch {
    // Best-effort — if we can't check, proceed with post
  }
  return null;
}

export async function findRecentDuplicate(
  issueId: string,
  body: string
): Promise<DuplicateMatch | null> {
  try {
    const self = await getSelfUser();
    const comments = await getComments(issueId, false);
    const cutoffMs = COMMENT_DEDUP_WINDOW_SECONDS * 1000;
    const now = Date.now();
    // Scan all recent comments by self within the window (newest first)
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (!c.createdAt || !c.user) continue;
      const ageMs = now - new Date(c.createdAt).getTime();
      if (ageMs > cutoffMs) break; // comments are sorted ascending; once too old, stop
      if (c.user.id !== self.id) continue;
      const similarity = computeWordSimilarity(c.body, body);
      if (similarity >= COMMENT_SIMILARITY_THRESHOLD) {
        const ageSeconds = Math.round(ageMs / 1000);
        process.stderr.write(
          `DUPLICATE_COMMENT_BLOCKED: similarity=${(similarity * 100).toFixed(0)}%, age=${ageSeconds}s, existingCommentId=${c.id}\n`
        );
        return { id: c.id, createdAt: c.createdAt, similarity, ageSeconds };
      }
    }
  } catch {
    // Best-effort — if we can't check, proceed with post
  }
  return null;
}

// --- Shared helpers ---

async function resolveComment(
  comment?: string,
  commentFile?: string
): Promise<string | undefined> {
  if (commentFile) {
    const content = await fs.readFile(commentFile, "utf8");
    return content.trim() || undefined;
  }
  const body = comment?.trim() || undefined;
  if (body) {
    warnInlineCommentSafety(body);
  }
  return body;
}

export function getInlineCommentSafetyWarning(body: string): string | null {
  const suspiciousShellCorruption = /\S {2,}\S/.test(body) || /(?:removed|updated|added|deleted|moved|renamed|linked|unlinked)\s{2,}(?:from|to|in|on|with|and|but|because|$)/i.test(body);
  const markdownOrCode = /`|```|\[[^\]]+\]\([^)]+\)|^\s{0,3}[-*]\s|^\s{0,3}\d+\.\s|#{1,6}\s|\*\*[^*]+\*\*/m.test(body);

  if (!suspiciousShellCorruption && !markdownOrCode) {
    return null;
  }

  const reason = suspiciousShellCorruption
    ? "looks like shell command-substitution may have stripped content"
    : "contains Markdown/code-like syntax";
  return `Warning: inline --comment ${reason}. Shell parses inline comments before linear receives them; use --comment-file for bodies with backticks, code, paths, or Markdown.`;
}

function warnInlineCommentSafety(body: string): void {
  const warning = getInlineCommentSafetyWarning(body);
  if (warning) {
    process.stderr.write(`${warning}\n`);
  }
}

function requireComment(
  command: string,
  comment?: string
): asserts comment is string {
  if (!comment) {
    throw new Error(
      `${command} requires a non-empty comment. Use --comment or --comment-file.`
    );
  }
}

// --- State machine types ---

export type CommentMode = "none" | "optional" | "required" | "optional-with-warning";

export interface StateTransition {
  /** Semantic state name to transition to (e.g. "thinking", "doing", "todo", "done") */
  targetState: string;
  /** Comment policy for this command */
  commentMode: CommentMode;
  /** Resolve a user by name and set as delegate? If set, the string is the user name argument. */
  delegateName?: string | ((args: TransitionArgs) => string | undefined);
  /** Resolve a user by name and set as assignee? If set, the string is the user name argument. */
  assigneeName?: string | ((args: TransitionArgs) => string | undefined);
  /** Set delegate to null? */
  clearDelegate?: boolean;
  /** Set assignee to null? */
  clearAssignee?: boolean;
  /** Set delegate to self (current authenticated user)? */
  delegateToSelf?: boolean;
  /** Comment before or after the state update? Default: false (after) */
  commentFirst?: boolean;
  /** Skip update when already in target state? (idempotency guard for beginWork) */
  skipIfSameState?: boolean;
  /** Include context (issue + comments) in result? (for considerWork) */
  includeContext?: boolean;
  /** Do not mutate terminal Linear issues (completed/canceled). Used by stale delegation hooks. */
  noopOnTerminal?: boolean;
  /** Refuse to take ownership unless the authenticated user is still the current delegate/assignee. */
  requireSelfAssignedOrDelegated?: boolean;
  /**
   * Stricter ownership check: refuse to proceed unless the authenticated user is the current
   * delegate (ignores assignee). Prevents concurrent-grab when delegate and assignee differ.
   */
  requireSelfDelegated?: boolean;
  /**
   * Skip the state transition (return no-op with context) when the issue's current state
   * position is strictly greater than the resolved target state's position.
   * Used by considerWork to prevent reverting a more-advanced state back to thinking when
   * a concurrent agent wake fires after another agent already advanced the ticket.
   */
  skipIfStatePositionAheadOfTarget?: boolean;
  /**
   * Label names to apply atomically with the state change. Resolved against
   * the issue's team before any mutation; throws clearly if any are missing.
   */
  addLabels?: string[];
  /**
   * Label names to strip atomically with the state change if currently
   * Always resolved and sent to Linear regardless of current presence; removing a
   * label not on the issue is a harmless no-op (AI-1389).
   */
  removeLabelsIfPresent?: string[];
  /**
   * AI-1498: Do NOT write the native `stateId` in this transition's mutation.
   * Set on governed dev-impl verbs (accept/submit/approve/request-changes/deploy/
   * reject/escape/demote): the connector proxy is the SOLE atomic writer of the
   * native column (folded into its one issueUpdate alongside label + delegate), so
   * the CLI must not also write stateId or the two writers drift. The target state
   * is still resolved for idempotency/position checks; only the write is suppressed.
   */
  omitStateId?: boolean;
}

export interface TransitionArgs {
  issueId: string;
  comment?: string;
  commentFile?: string;
  /** Positional user name argument (used when delegateName/assigneeName is a string) */
  userName?: string;
  /** Command name for contextual error hints */
  commandName?: string;
  /** Bypass near-duplicate comment detection and force the post. */
  forceDuplicate?: boolean;
}

export interface TransitionResult extends SemanticResult {
  context?: ObserveResult;
}

function isTerminalState(state?: { name?: string | null; type?: string | null } | null): boolean {
  const type = state?.type?.toLowerCase() ?? "";
  const name = state?.name?.toLowerCase() ?? "";
  return type === "completed" || type === "canceled" || name === "done" || name === "canceled" || name === "cancelled";
}

/**
 * Whether the issue's current delegate/assignee already match what the
 * transition config would set. Used by the same-state idempotency guard so a
 * ticket that is already in the target state but has the wrong owner (e.g. a
 * Managing ticket with delegate=null) still gets repaired instead of skipped.
 */
async function ownershipSatisfied(
  issue: Awaited<ReturnType<typeof getIssue>>,
  config: StateTransition,
  args: TransitionArgs
): Promise<boolean> {
  const currentDelegateId = issue.delegate?.id ?? null;
  const currentAssigneeId = issue.assignee?.id ?? null;

  if (config.delegateToSelf) {
    const self = await getSelfUser();
    if (currentDelegateId !== self.id) return false;
  } else if (config.clearDelegate) {
    if (currentDelegateId !== null) return false;
  } else if (config.delegateName) {
    const name = typeof config.delegateName === "function" ? config.delegateName(args) : config.delegateName;
    if (name) {
      const user = await resolveUserWithHints(name, args.commandName);
      if (currentDelegateId !== user.id) return false;
    }
  }

  if (config.clearAssignee) {
    if (currentAssigneeId !== null) return false;
  } else if (config.assigneeName) {
    const name = typeof config.assigneeName === "function" ? config.assigneeName(args) : config.assigneeName;
    if (name) {
      const user = await resolveUserWithHints(name, args.commandName);
      if (currentAssigneeId !== user.id) return false;
    }
  }

  return true;
}

async function buildObserveContext(issue: Awaited<ReturnType<typeof getIssue>>): Promise<ObserveResult> {
  const [comments, history] = await Promise.all([
    getComments(issue.id),
    getIssueHistory(issue.id),
  ]);
  const rawComments = comments.map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.createdAt ?? "",
    user: c.user ? { name: c.user.name, isAgent: c.user.isAgent, app: c.user.app } : { name: "Unknown" },
  }));
  rawComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

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
    comments: rawComments,
    history: historyToTimelineEvents(history),
  };
}

// --- State machine executor ---

/**
 * Execute a semantic command's state transition against a Linear issue.
 *
 * This is the shared core that all 6 semantic commands delegate to.
 * Each command defines its transition config and calls this function.
 */
export async function executeTransition(
  commandName: string,
  args: TransitionArgs,
  config: StateTransition
): Promise<TransitionResult> {
  // 1. Fetch issue and resolve team
  const issue = await getIssue(args.issueId);
  const teamId = issue.team?.id;
  if (!teamId) {
    throw new Error(`Issue ${issue.identifier} has no team.`);
  }

  const nullResult = (stateName: string): TransitionResult => ({
    command: commandName,
    issueId: issue.identifier,
    state: stateName,
    delegate: issue.delegate?.name ?? null,
    assignee: issue.assignee?.name ?? null,
    commentPosted: false,
    duplicateBlocked: false,
    rateLimitBlocked: false,
    rateLimitDetails: null,
    duplicateDetails: null,
    commentId: null,
    commentUrl: null,
    commentCreatedAt: null,
    commentBodyLength: null,
    bodyFile: null,
  });

  if (config.noopOnTerminal && isTerminalState(issue.state)) {
    const result = nullResult(issue.state?.name ?? "Unknown");
    if (config.includeContext) {
      result.context = await buildObserveContext(issue);
    }
    return result;
  }

  if (config.requireSelfAssignedOrDelegated) {
    const self = await getSelfUser();
    const currentDelegateId = issue.delegate?.id ?? null;
    const currentAssigneeId = issue.assignee?.id ?? null;
    const isCurrentOwner = currentDelegateId === self.id || currentAssigneeId === self.id;

    if (!isCurrentOwner) {
      const result = nullResult(issue.state?.name ?? "Unknown");
      if (config.includeContext) {
        result.context = await buildObserveContext(issue);
      }
      return result;
    }
  }

  // Stricter ownership check: delegate-only (ignores assignee).
  // Prevents concurrent-grab where both delegate and assignee invoke consider-work
  // simultaneously and stomp each other's state transitions (AI-1394).
  if (config.requireSelfDelegated) {
    const self = await getSelfUser();
    const currentDelegateId = issue.delegate?.id ?? null;
    if (currentDelegateId !== self.id) {
      const result = nullResult(issue.state?.name ?? "Unknown");
      if (config.includeContext) {
        result.context = await buildObserveContext(issue);
      }
      return result;
    }
  }

  // 2. Resolve target state
  const state = await findSemanticState(teamId, config.targetState);

  // 2.5. Position-based advancement guard: skip if the current state is already
  //      further along in the workflow than the target state. This prevents
  //      consider-work (target=thinking) from reverting a more-advanced state
  //      (e.g. Doing, code-review, deployment) when a concurrent agent wake fires
  //      after another agent has already advanced the ticket (AI-1394).
  if (config.skipIfStatePositionAheadOfTarget) {
    const currentPosition = issue.state?.position ?? null;
    const targetPosition = state.position ?? null;
    if (currentPosition !== null && targetPosition !== null && currentPosition > targetPosition) {
      const result = nullResult(issue.state?.name ?? "Unknown");
      if (config.includeContext) {
        result.context = await buildObserveContext(issue);
      }
      return result;
    }
  }

  // 3. Idempotency check — skip the update only if already in the target state
  //    AND the command's ownership invariants (delegate/assignee) already hold.
  //    A same-state ticket with the wrong delegate/assignee still needs repair,
  //    so we fall through to the update in that case.
  if (config.skipIfSameState) {
    const currentStateName = issue.state?.name?.toLowerCase() ?? "";
    const targetStateName = state.name.toLowerCase();
    if (currentStateName === targetStateName && await ownershipSatisfied(issue, config, args)) {
      return nullResult(state.name);
    }
  }

  // 3.5. Resolve labels (fail-fast before any mutation)
  let addedLabelIds: string[] | undefined;
  let removedLabelIds: string[] | undefined;
  if (config.addLabels?.length) {
    addedLabelIds = await resolveLabelIds(teamId, config.addLabels);
  }
  // AI-1404: Linear does NOT silently no-op removedLabelIds for labels absent from the issue —
  // it throws a validation error. Filter by names present on the issue before resolving IDs.
  if (config.removeLabelsIfPresent?.length) {
    const present = new Set((issue.labels ?? []).map((l) => l.name.toLowerCase()));
    const toRemove = config.removeLabelsIfPresent.filter((n) => present.has(n.toLowerCase()));
    if (toRemove.length) {
      removedLabelIds = await resolveLabelIds(teamId, toRemove);
    }
  }

  // 4. Resolve comment
  const body = await resolveComment(args.comment, args.commentFile);
  if (config.commentMode === "required") {
    requireComment(commandName, body);
  } else if (config.commentMode === "optional-with-warning" && !body) {
    process.stderr.write(`Warning: no comment provided on ${args.commandName ?? commandName}. This is acceptable if a comment was posted earlier in this session.\n`);
  }

  // 5. Resolve delegate
  let delegateId: string | null | undefined = undefined; // undefined = don't touch, null = clear
  let delegateName: string | null = null;
  let delegateIsAppUser = false;
  if (config.delegateToSelf) {
    const self = await getSelfUser();
    delegateId = self.id;
    delegateName = self.name;
  } else if (config.clearDelegate) {
    delegateId = null;
    delegateName = null;
  } else if (config.delegateName) {
    const name = typeof config.delegateName === "function"
      ? config.delegateName(args)
      : config.delegateName;
    if (name) {
      const user = await resolveUserWithHints(name, args.commandName);
      delegateId = user.id;
      delegateName = user.name;
      delegateIsAppUser = !!user.app;
    }
  }

  // 6. Resolve assignee
  let assigneeId: string | null | undefined = undefined; // undefined = don't touch, null = clear
  let assigneeNameResult: string | null = null;
  if (config.clearAssignee) {
    assigneeId = null;
  } else if (config.assigneeName) {
    const name = typeof config.assigneeName === "function"
      ? config.assigneeName(args)
      : config.assigneeName;
    if (name) {
      const user = await resolveUserWithHints(name, args.commandName);
      assigneeId = user.id;
      assigneeNameResult = user.name;
    }
  }

  // Linear API constraint for app/bot user delegates (AI-1395):
  //   • { delegateId: app_user, assigneeId: null }    → delegate silently dropped
  //   • { delegateId: app_user, assigneeId: app_user } → explicit API error
  //   • { delegateId: app_user }                      → delegate persists
  // When the delegate is an app user, omit assigneeId entirely so Linear
  // accepts the write. This overrides clearAssignee for app-user delegates.
  if (delegateId && delegateIsAppUser) {
    process.stderr.write(
      `Info: delegate "${delegateName}" is an app user; omitting assigneeId from mutation to satisfy Linear API constraint (AI-1395).\n`
    );
    assigneeId = undefined;
    assigneeNameResult = null;
  }

  // 7. Post comment (before update if commentFirst)
  let commentPosted = false;
  let duplicateBlocked = false;
  let rateLimitBlocked = false;
  let rateLimitDetails: { recentCount: number; maxAllowed: number; windowSeconds: number } | null = null;
  let duplicateDetails: SemanticResult["duplicateDetails"] = null;
  let commentId: string | null = null;
  let commentUrl: string | null = null;
  let commentCreatedAt: string | null = null;
  let commentBodyLength: number | null = null;
  let bodyFile: string | null = null;
  if (body && config.commentMode !== "none") {
    if (config.commentFirst) {
      // Rate limit check (independent of similarity)
      const rateHit = args.forceDuplicate ? null : await checkCommentRateLimit(args.issueId);
      if (rateHit) {
        rateLimitBlocked = true;
        rateLimitDetails = { recentCount: rateHit.recentCount, maxAllowed: rateHit.maxAllowed, windowSeconds: rateHit.windowSeconds };
      } else {
        const dup = args.forceDuplicate ? null : await findRecentDuplicate(args.issueId, body);
        if (dup) {
          duplicateBlocked = true;
          duplicateDetails = { existingCommentId: dup.id, similarity: dup.similarity, ageSeconds: dup.ageSeconds };
          commentId = dup.id;
        } else {
          const result = await addComment(args.issueId, body);
          commentId = result.commentId;
          commentUrl = result.commentUrl;
          commentCreatedAt = result.commentCreatedAt;
          commentBodyLength = result.commentBodyLength;
          bodyFile = result.bodyFile ?? null;
          commentPosted = true;
        }
      }
    }
  }

  // 8. Build update payload
  // AI-1498: governed dev-impl verbs omit stateId — the connector proxy is the
  // sole atomic writer of the native column. All other (non-governed) commands
  // still write stateId here, since the proxy forwards them unchanged.
  const updatePayload: Record<string, any> = config.omitStateId ? {} : { stateId: state.id };
  if (delegateId !== undefined) updatePayload.delegateId = delegateId;
  if (assigneeId !== undefined) updatePayload.assigneeId = assigneeId;
  if (addedLabelIds?.length) updatePayload.addedLabelIds = addedLabelIds;
  if (removedLabelIds?.length) updatePayload.removedLabelIds = removedLabelIds;

  // 9. Execute update
  const updatedIssue = await updateIssue(args.issueId, updatePayload);

  // 9.5. Post-update label verification: if the mutation set a new state:* label
  //      but a prior state:* label persists (concurrent write, API race), issue a
  //      corrective removal to guarantee at most one state:* label (AI-1389).
  if (config.addLabels?.length && config.removeLabelsIfPresent?.length) {
    const newStateLabels = config.addLabels.filter((n) => n.toLowerCase().startsWith("state:"));
    if (newStateLabels.length > 0) {
      const actualLabels = (updatedIssue.labels ?? []).map((l) => l.name.toLowerCase());
      const staleLabels = actualLabels.filter(
        (l) => l.startsWith("state:") && !newStateLabels.some((n) => n.toLowerCase() === l)
      );
      if (staleLabels.length > 0) {
        process.stderr.write(
          `Warning: stale state:* labels detected after update: [${staleLabels.join(", ")}]. ` +
          `Issuing corrective removal (AI-1389).\n`
        );
        const staleIds = await resolveLabelIds(teamId, staleLabels);
        if (staleIds.length > 0) {
          await updateIssue(args.issueId, { removedLabelIds: staleIds });
        }
      }
    }
  }

  // 10. Post comment (after update if not commentFirst)
  if (body && config.commentMode !== "none" && !config.commentFirst) {
    // Rate limit check (independent of similarity)
    const rateHit = args.forceDuplicate ? null : await checkCommentRateLimit(args.issueId);
    if (rateHit) {
      rateLimitBlocked = true;
      rateLimitDetails = { recentCount: rateHit.recentCount, maxAllowed: rateHit.maxAllowed, windowSeconds: rateHit.windowSeconds };
    } else {
      const dup = args.forceDuplicate ? null : await findRecentDuplicate(args.issueId, body);
      if (dup) {
        duplicateBlocked = true;
        duplicateDetails = { existingCommentId: dup.id, similarity: dup.similarity, ageSeconds: dup.ageSeconds };
        commentId = dup.id;
      } else {
        const result = await addComment(args.issueId, body);
        commentId = result.commentId;
        commentUrl = result.commentUrl;
        commentCreatedAt = result.commentCreatedAt;
        commentBodyLength = result.commentBodyLength;
        bodyFile = result.bodyFile ?? null;
        commentPosted = true;
      }
    }
  }

  // 11. Build result — use actual server state from updatedIssue, not intended values,
  //     so silent rejections (e.g. app-user delegate constraint) surface immediately.
  if (delegateId && updatedIssue.delegate?.id !== delegateId) {
    process.stderr.write(
      `Warning: delegate write did not persist. Expected "${delegateName}", ` +
      `got "${updatedIssue.delegate?.name ?? "null"}". ` +
      `If the target is an app user, ensure the Linear API constraint is satisfied (AI-1395).\n`
    );
  }

  const result: TransitionResult = {
    command: commandName,
    issueId: issue.identifier,
    state: state.name,
    delegate: updatedIssue.delegate?.name ?? null,
    assignee: updatedIssue.assignee?.name ?? null,
    commentPosted,
    duplicateBlocked,
    rateLimitBlocked,
    rateLimitDetails,
    duplicateDetails,
    commentId: commentId ?? null,
    commentUrl: commentUrl ?? null,
    commentCreatedAt: commentCreatedAt ?? null,
    commentBodyLength: commentBodyLength ?? null,
    bodyFile: bodyFile ?? null,
  };

  // 12. Include context for considerWork
  if (config.includeContext) {
    result.context = await buildObserveContext(updatedIssue);
  }

  return result;
}
