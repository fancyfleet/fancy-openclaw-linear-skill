import fs from "node:fs/promises";

import { getSelfUser } from "./auth";
import { getComments, getIssueHistory } from "./boards";
import { addComment, findUserByName, resolveUserWithHints, getIssue, updateIssue } from "./issues";
import { findSemanticState } from "./states";
import { ObserveResult, SemanticResult, historyToTimelineEvents } from "./semantic";

// --- Comment deduplication ---

/**
 * Dedup window in seconds. If the last comment from the authenticated user
 * has the same body and was posted within this window, skip posting.
 */
const COMMENT_DEDUP_WINDOW_SECONDS = 60;

/**
 * Strip HTML/Prosemirror markup for body comparison.
 */
function stripMarkup(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, "").replace(/\s+/g, " ").trim();
}

/**
 * Check whether a comment with the given body would be a duplicate of the
 * most recent comment on the issue. Returns the matching comment if found,
 * null otherwise. Best-effort: failures return null (proceed with post).
 */
export async function findRecentDuplicate(
  issueId: string,
  body: string
): Promise<{ id: string; createdAt: string } | null> {
  try {
    const self = await getSelfUser();
    const comments = await getComments(issueId, false);
    // comments are sorted ascending; get the last one
    const last = comments[comments.length - 1];
    if (
      last &&
      last.user?.id === self.id &&
      stripMarkup(last.body) === stripMarkup(body) &&
      last.createdAt &&
      (Date.now() - new Date(last.createdAt).getTime()) / 1000 < COMMENT_DEDUP_WINDOW_SECONDS
    ) {
      return { id: last.id, createdAt: last.createdAt };
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

export type CommentMode = "none" | "optional" | "required";

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
}

export interface TransitionArgs {
  issueId: string;
  comment?: string;
  commentFile?: string;
  /** Positional user name argument (used when delegateName/assigneeName is a string) */
  userName?: string;
  /** Command name for contextual error hints */
  commandName?: string;
}

export interface TransitionResult extends SemanticResult {
  context?: ObserveResult;
}

function isTerminalState(state?: { name?: string | null; type?: string | null } | null): boolean {
  const type = state?.type?.toLowerCase() ?? "";
  const name = state?.name?.toLowerCase() ?? "";
  return type === "completed" || type === "canceled" || name === "done" || name === "canceled" || name === "cancelled";
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

  if (config.noopOnTerminal && isTerminalState(issue.state)) {
    const result: TransitionResult = {
      command: commandName,
      issueId: issue.identifier,
      state: issue.state?.name ?? "Unknown",
      delegate: issue.delegate?.name ?? null,
      assignee: issue.assignee?.name ?? null,
      commentPosted: false,
      commentId: null,
      commentUrl: null,
      commentCreatedAt: null,
      commentBodyLength: null,
      bodyFile: null,
    };
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
      const result: TransitionResult = {
        command: commandName,
        issueId: issue.identifier,
        state: issue.state?.name ?? "Unknown",
        delegate: issue.delegate?.name ?? null,
        assignee: issue.assignee?.name ?? null,
        commentPosted: false,
        commentId: null,
        commentUrl: null,
        commentCreatedAt: null,
        commentBodyLength: null,
        bodyFile: null,
      };
      if (config.includeContext) {
        result.context = await buildObserveContext(issue);
      }
      return result;
    }
  }

  // 2. Resolve target state
  const state = await findSemanticState(teamId, config.targetState);

  // 3. Idempotency check — skip update if already in target state
  if (config.skipIfSameState) {
    const currentStateName = issue.state?.name?.toLowerCase() ?? "";
    const targetStateName = state.name.toLowerCase();
    if (currentStateName === targetStateName) {
      return {
        command: commandName,
        issueId: issue.identifier,
        state: state.name,
        delegate: issue.delegate?.name ?? null,
        assignee: issue.assignee?.name ?? null,
        commentPosted: false,
        commentId: null,
        commentUrl: null,
        commentCreatedAt: null,
        commentBodyLength: null,
        bodyFile: null,
      };
    }
  }

  // 4. Resolve comment
  const body = await resolveComment(args.comment, args.commentFile);
  if (config.commentMode === "required") {
    requireComment(commandName, body);
  }

  // 5. Resolve delegate
  let delegateId: string | null | undefined = undefined; // undefined = don't touch, null = clear
  let delegateName: string | null = null;
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

  // 7. Post comment (before update if commentFirst)
  let commentPosted = false;
  let commentId: string | null = null;
  let commentUrl: string | null = null;
  let commentCreatedAt: string | null = null;
  let commentBodyLength: number | null = null;
  let bodyFile: string | null = null;
  if (body && config.commentMode !== "none") {
    if (config.commentFirst) {
      // Dedup: skip if last comment from self is a recent duplicate
      const dup = await findRecentDuplicate(args.issueId, body);
      if (dup) {
        commentId = dup.id;
        commentUrl = null;  // dedup: url not available from getComments
        commentCreatedAt = dup.createdAt;
        commentBodyLength = Buffer.byteLength(body, "utf8");
        commentPosted = true;
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

  // 8. Build update payload
  const updatePayload: Record<string, any> = { stateId: state.id };
  if (delegateId !== undefined) updatePayload.delegateId = delegateId;
  if (assigneeId !== undefined) updatePayload.assigneeId = assigneeId;

  // 9. Execute update
  const updatedIssue = await updateIssue(args.issueId, updatePayload);

  // 10. Post comment (after update if not commentFirst)
  if (body && config.commentMode !== "none" && !config.commentFirst) {
    // Dedup: skip if last comment from self is a recent duplicate
    const dup = await findRecentDuplicate(args.issueId, body);
    if (dup) {
      commentId = dup.id;
      commentUrl = null;  // dedup: url not available from getComments
      commentCreatedAt = dup.createdAt;
      commentBodyLength = Buffer.byteLength(body, "utf8");
      commentPosted = true;
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

  // 11. Build result
  const result: TransitionResult = {
    command: commandName,
    issueId: issue.identifier,
    state: state.name,
    delegate: config.delegateToSelf ? delegateName
      : config.clearDelegate ? null
      : delegateName ?? issue.delegate?.name ?? null,
    assignee: config.clearAssignee ? null
      : assigneeNameResult ?? issue.assignee?.name ?? null,
    commentPosted,
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
