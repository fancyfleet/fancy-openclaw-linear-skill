import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { linearGraphQL } from "./client";
import { getSelfUser } from "./auth";
import { ISSUE_FIELDS, STATE_BLOCK, ASSIGNEE_BLOCK, TEAM_BLOCK, DELEGATE_BLOCK } from "./fragments";
import { captionChunks, chunkCommentBody, DEFAULT_MAX_COMMENT_BYTES } from "./chunk";
import { findSemanticState } from "./states";
import { CreateIssueInput, Issue, UpdateIssueInput } from "./types";

interface IssueResponse {
  issue: RawIssue | null;
}

interface IssuesResponse {
  viewer: {
    assignedIssues: {
      nodes: Issue[];
    };
  };
}

interface SearchUsersResponse {
  users: {
    nodes: Array<{ id: string; name: string; email?: string | null; app?: boolean | null }>;
  };
}

interface CreateIssueMutationResponse {
  issueCreate: {
    success: boolean;
    issue: Issue | null;
  };
}

interface UpdateIssueMutationResponse {
  issueUpdate: {
    success: boolean;
    issue: Issue | null;
  };
}

interface CommentCreateResponse {
  commentCreate: {
    success: boolean;
    comment: {
      id: string;
      body: string;
      createdAt: string;
      url: string;
    } | null;
  };
}

// ISSUE_FIELDS imported from ./fragments

interface RawIssue extends Omit<Issue, "milestone" | "labels" | "relations" | "comments" | "children"> {
  projectMilestone?: Issue["milestone"];
  labels?: { nodes?: Issue["labels"] };
  relations?: { nodes?: Issue["relations"] };
  comments?: { nodes?: Issue["comments"] };
  children?: { nodes?: Issue["children"] };
}

function normalizeIssue(issue: RawIssue): Issue {
  return {
    ...issue,
    milestone: issue.projectMilestone ?? null,
    labels: issue.labels?.nodes ?? [],
    relations: issue.relations?.nodes ?? [],
    comments: issue.comments?.nodes ?? [],
    children: issue.children?.nodes ?? []
  };
}

interface IssuesByFilterResponse {
  issues: {
    nodes: RawIssue[];
  };
}

const IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

export async function getIssue(id: string): Promise<Issue> {
  const identifierMatch = IDENTIFIER_RE.exec(id);
  if (identifierMatch) {
    const teamKey = identifierMatch[1].toUpperCase();
    const number = Number(identifierMatch[2]);
    const data = await linearGraphQL<IssuesByFilterResponse>(
      `
        query IssueByIdentifier($teamKey: String!, $number: Float!) {
          issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }) {
            nodes {
              ${ISSUE_FIELDS}
            }
          }
        }
      `,
      { teamKey, number }
    );
    if (!data.issues.nodes.length) {
      throw new Error(`Issue not found: ${id}`);
    }
    return normalizeIssue(data.issues.nodes[0]);
  }

  const data = await linearGraphQL<IssueResponse>(
    `
      query IssueDetail($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
        }
      }
    `,
    { id }
  );
  if (!data.issue) {
    throw new Error(`Issue not found: ${id}`);
  }
  return normalizeIssue(data.issue);
}

export async function createIssue(input: CreateIssueInput): Promise<Issue> {
  if (!input.projectId) {
    process.stderr.write("Warning: no-orphan warning: creating issue without --project\n");
  }

  // Without an explicit stateId, Linear's API silently lands the issue in Backlog
  // when no project is set — and Backlog tickets aren't auto-dispatched by the
  // connector. Resolve the team's "To Do" state and pass it explicitly so the
  // CLI default matches the help text and the connector picks the issue up.
  let stateId = input.stateId;
  if (!stateId && input.teamId) {
    try {
      stateId = (await findSemanticState(input.teamId, "todo")).id;
    } catch (err) {
      process.stderr.write(
        `Warning: could not resolve default "To Do" state for team ${input.teamId}; ` +
        `falling back to Linear's API default. Reason: ${(err as Error).message}\n`
      );
    }
  }

  const data = await linearGraphQL<CreateIssueMutationResponse>(
    `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
          }
        }
      }
    `,
    {
      input: {
        ...(input.teamId ? { teamId: input.teamId } : {}),
        title: input.title,
        description: input.description,
        projectId: input.projectId,
        projectMilestoneId: input.projectMilestoneId,
        assigneeId: input.assigneeId,
        delegateId: input.delegateId,
        priority: input.priority,
        parentId: input.parentId,
        ...(stateId ? { stateId } : {})
      }
    }
  );

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("Linear issueCreate mutation failed.");
  }

  return getIssue(data.issueCreate.issue.id);
}

export async function updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
  const resolvedInput: UpdateIssueInput = { ...input };
  if (input.description) {
    resolvedInput.description = await rewriteWithWorkspaceLinks(input.description);
  }

  const data = await linearGraphQL<UpdateIssueMutationResponse>(
    `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
          }
        }
      }
    `,
    {
      id,
      input: resolvedInput
    }
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error(`Linear issueUpdate mutation failed for issue ${id}.`);
  }

  return getIssue(data.issueUpdate.issue.id);
}

// ---------------------------------------------------------------------------
// Issue-identifier rewriting for clickable Markdown links
// ---------------------------------------------------------------------------

const BARE_ISSUE_RE = /\b([A-Z]{2,10}-\d+)\b/g;
const HAS_BARE_ISSUE_RE = /\b[A-Z]{2,10}-\d+\b/;

// Regex that skips bare identifiers inside code blocks, code spans, markdown links, or URLs
const SKIP_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /!?\[[^\]]*\]\([^)]*\)/g,
  /https?:\/\/\S+/g
];

let cachedWorkspaceUrlKey: string | undefined;

interface OrganizationResponse {
  organization: { urlKey: string };
}

export function _resetWorkspaceUrlKeyCache(): void {
  cachedWorkspaceUrlKey = undefined;
}

export async function getWorkspaceUrlKey(): Promise<string> {
  if (cachedWorkspaceUrlKey) return cachedWorkspaceUrlKey;
  const data = await linearGraphQL<OrganizationResponse>(
    `query OrganizationUrlKey { organization { urlKey } }`
  );
  cachedWorkspaceUrlKey = data.organization.urlKey;
  return cachedWorkspaceUrlKey;
}

function findSkipRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const re of SKIP_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

function inAnyRange(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (idx >= s && idx < e) return true;
  }
  return false;
}

/**
 * Rewrite bare Linear issue identifiers (e.g. AI-424) into Markdown links
 * pointing at the workspace URL, skipping identifiers that appear inside
 * code blocks, code spans, existing Markdown links, or bare URLs.
 */
export function rewriteIssueLinks(text: string, urlKey: string): string {
  if (!HAS_BARE_ISSUE_RE.test(text)) return text;
  const skipRanges = findSkipRanges(text);
  const matches: { index: number; length: number; id: string }[] = [];
  BARE_ISSUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_ISSUE_RE.exec(text)) !== null) {
    matches.push({ index: m.index, length: m[0].length, id: m[1] });
  }
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, length, id } = matches[i];
    if (inAnyRange(index, skipRanges)) continue;
    const url = `https://linear.app/${urlKey}/issue/${id}`;
    result = result.slice(0, index) + `[${id}](${url})` + result.slice(index + length);
  }
  return result;
}

async function rewriteWithWorkspaceLinks(text: string): Promise<string> {
  if (!HAS_BARE_ISSUE_RE.test(text)) return text;
  try {
    const urlKey = await getWorkspaceUrlKey();
    return rewriteIssueLinks(text, urlKey);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Prosemirror bodyData for native Linear issue mentions
// ---------------------------------------------------------------------------

interface ProsemirrorIssueMention {
  type: "issueMention";
  attrs: {
    id: string;
    label: string;
    href: string;
    title: string;
  };
}

type ProsemirrorNode =
  | { type: "doc"; content: ProsemirrorNode[] }
  | { type: "paragraph"; content: ProsemirrorNode[] }
  | { type: "heading"; attrs: { level: number; id: string }; content: ProsemirrorNode[] }
  | { type: "text"; text: string }
  | { type: "hardBreak" }
  | ProsemirrorIssueMention;

/**
 * Build a Prosemirror JSON document from plain text, replacing bare issue
 * identifiers with native `issueMention` nodes.
 * Returns null if no resolvable identifiers are found (caller falls back
 * to plain Markdown or link-rewritten Markdown).
 *
 * Linear's Prosemirror schema expects `issueMention` nodes (not
 * `issueReference`) with attrs: { id, label, href, title }.
 */
export async function buildProsemirrorBody(text: string): Promise<object | null> {
  // Quick check — skip if no identifiers present
  if (!HAS_BARE_ISSUE_RE.test(text)) return null;

  // Find skip ranges (code blocks, links, URLs) so we don't touch identifiers there
  const skipRanges = findSkipRanges(text);

  // Collect unique identifiers that are NOT in skip ranges
  const identifiers = new Set<string>();
  BARE_ISSUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_ISSUE_RE.exec(text)) !== null) {
    if (!inAnyRange(m.index, skipRanges)) {
      identifiers.add(m[1]);
    }
  }
  if (identifiers.size === 0) return null;

  // Resolve identifiers to issue metadata (best-effort)
  const issueMap = new Map<string, { id: string; identifier: string; title: string }>();
  await Promise.all(
    [...identifiers].map(async (identifier) => {
      try {
        const issue = await getIssue(identifier);
        issueMap.set(identifier, { id: issue.id, identifier: issue.identifier, title: issue.title });
      } catch {
        // Can't resolve — leave as plain text
      }
    })
  );

  if (issueMap.size === 0) return null;

  // Get workspace URL key for building hrefs
  let urlKey: string;
  try {
    urlKey = await getWorkspaceUrlKey();
  } catch {
    return null; // Can't build proper hrefs without urlKey
  }

  // Build Prosemirror doc
  // Split on double-newline for paragraph boundaries.
  // Single newlines within a block become hardBreak nodes.
  const blockTexts = text.split(/\n\n+/);
  const blockNodes: ProsemirrorNode[] = [];

  // Regex to detect markdown heading lines
  const headingRe = /^(#{1,6})\s+(.*)$/;

  for (const blockText of blockTexts) {
    if (blockText.trim().length === 0) continue;

    // Split block into lines for heading detection
    const blockLines = blockText.split("\n");
    const firstLine = blockLines[0];
    const headingMatch = headingRe.exec(firstLine);

    if (headingMatch) {
      // Heading block — first line is the heading, rest are separate paragraphs
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const headingContent = buildInlineNodes(headingText, issueMap, skipRanges, urlKey);
      if (headingContent.length > 0) {
        const headingId = headingText
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60) + "-" + Math.random().toString(36).slice(2, 8);
        blockNodes.push({ type: "heading", attrs: { level, id: headingId }, content: headingContent });
      }
      // Remaining lines in this block become regular paragraphs
      for (let i = 1; i < blockLines.length; i++) {
        const lineNodes = buildInlineNodes(blockLines[i], issueMap, skipRanges, urlKey);
        if (lineNodes.length > 0) {
          blockNodes.push({ type: "paragraph", content: lineNodes });
        }
      }
      continue;
    }

    // Regular paragraph block — join lines with hardBreak nodes
    const inlineNodes: ProsemirrorNode[] = [];
    for (let i = 0; i < blockLines.length; i++) {
      if (i > 0 && inlineNodes.length > 0) {
        inlineNodes.push({ type: "hardBreak" });
      }
      const lineNodes = buildInlineNodes(blockLines[i], issueMap, skipRanges, urlKey);
      inlineNodes.push(...lineNodes);
    }
    if (inlineNodes.length > 0) {
      blockNodes.push({ type: "paragraph", content: inlineNodes });
    }
  }

  if (blockNodes.length === 0) return null;

  return { type: "doc", content: blockNodes };
}

/**
 * Build inline Prosemirror nodes from a single line of text,
 * replacing bare issue identifiers with issueMention nodes.
 */
function buildInlineNodes(
  line: string,
  issueMap: Map<string, { id: string; identifier: string; title: string }>,
  skipRanges: Array<[number, number]>,
  urlKey: string
): ProsemirrorNode[] {
  if (line.trim().length === 0) return [];
  const nodes: ProsemirrorNode[] = [];
  let lastIndex = 0;

  BARE_ISSUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_ISSUE_RE.exec(line)) !== null) {
    const [fullMatch, identifier] = match;
    const issueInfo = issueMap.get(identifier);

    // Skip identifiers inside code blocks/links/URLs or unresolvable ones
    if (inAnyRange(match.index, skipRanges) || !issueInfo) {
      continue;
    }

    // Emit preceding text
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: line.slice(lastIndex, match.index) });
    }

    // Emit issueMention node
    const slug = issueInfo.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    nodes.push({
      type: "issueMention",
      attrs: {
        id: issueInfo.id,
        label: issueInfo.identifier,
        href: `https://linear.app/${urlKey}/issue/${issueInfo.identifier}/${slug}`,
        title: issueInfo.title
      }
    });

    lastIndex = match.index + fullMatch.length;
  }

  // Emit trailing text
  if (lastIndex < line.length) {
    nodes.push({ type: "text", text: line.slice(lastIndex) });
  }

  return nodes;
}

type AddCommentResult = {
  issueId: string;
  commentId: string;
  commentUrl: string | null;
  commentCreatedAt: string;
  commentBodyLength: number;
  body: string;
  bodyFile?: string;
  chunkCount?: number;
};

type AddCommentOptions = {
  maxBytes?: number;
  noSplit?: boolean;
};

export async function addComment(issueId: string, body: string, options: AddCommentOptions = {}): Promise<AddCommentResult> {

  let finalBody = body.replace(/\\n/g, "\n");
  let tempFilePath: string | undefined;

  if (Buffer.byteLength(body, "utf8") > 4 * 1024) {
    tempFilePath = path.join(os.tmpdir(), `linear-comment-${issueId}-${Date.now()}.md`);
    await fs.writeFile(tempFilePath, body, "utf8");
    finalBody = await fs.readFile(tempFilePath, "utf8");
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_COMMENT_BYTES;
  if (!options.noSplit && Buffer.byteLength(finalBody, "utf8") > maxBytes) {
    const chunks = captionChunks(chunkCommentBody(finalBody, maxBytes));
    let first: AddCommentResult | undefined;

    for (const chunk of chunks) {
      const rewrittenChunk = await rewriteWithWorkspaceLinks(chunk);
      const data = await linearGraphQL<CommentCreateResponse>(
        `
          mutation AddComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment {
                id
                body
                createdAt
                url
              }
            }
          }
        `,
        { issueId, body: rewrittenChunk }
      );

      if (!data.commentCreate.success || !data.commentCreate.comment) {
        throw new Error(`Failed to create comment for issue ${issueId}.`);
      }

      const result: AddCommentResult = {
        issueId,
        commentId: data.commentCreate.comment.id,
        commentUrl: data.commentCreate.comment.url,
        commentCreatedAt: data.commentCreate.comment.createdAt,
        commentBodyLength: Buffer.byteLength(rewrittenChunk, "utf8"),
        body: data.commentCreate.comment.body,
        bodyFile: tempFilePath,
        chunkCount: chunks.length
      };
      first ??= result;
    }

    return first!;
  }

  // Strategy 1: try Prosemirror bodyData with native issueMention nodes
  try {
    const bodyData = await buildProsemirrorBody(finalBody);
    if (bodyData) {
      const data = await linearGraphQL<CommentCreateResponse>(
        `
          mutation AddComment($issueId: String!, $bodyData: JSON!) {
            commentCreate(input: { issueId: $issueId, bodyData: $bodyData }) {
              success
              comment {
                id
                body
                createdAt
                url
              }
            }
          }
        `,
        { issueId, bodyData: JSON.stringify(bodyData) }
      );

      if (data.commentCreate.success && data.commentCreate.comment) {
        return {
          issueId,
          commentId: data.commentCreate.comment.id,
          commentUrl: data.commentCreate.comment.url,
          commentCreatedAt: data.commentCreate.comment.createdAt,
          commentBodyLength: Buffer.byteLength(finalBody, "utf8"),
          body: data.commentCreate.comment.body,
          bodyFile: tempFilePath
        };
      }
    }
  } catch {
    // Prosemirror path failed — fall through to Markdown
  }

  // Strategy 2: Markdown with rewritten issue links
  finalBody = await rewriteWithWorkspaceLinks(finalBody);

  const data = await linearGraphQL<CommentCreateResponse>(
    `
      mutation AddComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
            body
            createdAt
            url
          }
        }
      }
    `,
    { issueId, body: finalBody }
  );

  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error(`Failed to create comment for issue ${issueId}.`);
  }

  return {
    issueId,
    commentId: data.commentCreate.comment.id,
    commentUrl: data.commentCreate.comment.url,
    commentCreatedAt: data.commentCreate.comment.createdAt,
    commentBodyLength: Buffer.byteLength(finalBody, "utf8"),
    body: data.commentCreate.comment.body,
    bodyFile: tempFilePath
  };
}

export async function getMyIssues(filterStateNames?: string[]): Promise<Issue[]> {
  const hasFilter = filterStateNames && filterStateNames.length > 0;
  const varDecl = hasFilter ? "($stateNames: [String!])" : "";
  const stateFilter = hasFilter ? ", filter: { state: { name: { in: $stateNames } } }" : "";
  const data = await linearGraphQL<IssuesResponse>(
    `
      query MyIssues${varDecl} {
        viewer {
          assignedIssues(first: 100${stateFilter}) {
            nodes {
              id
              identifier
              title
              updatedAt
              priority
              ${STATE_BLOCK}
              ${ASSIGNEE_BLOCK}
              ${TEAM_BLOCK}
              project { id name }
            }
          }
        }
      }
    `,
    { stateNames: filterStateNames }
  );

  return data.viewer.assignedIssues.nodes;
}

export async function getMyNewIssues(updatedSinceIso?: string): Promise<Issue[]> {
  const since = updatedSinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const data = await linearGraphQL<IssuesResponse>(
    `
      query MyNewIssues($updatedAt: DateTimeOrDuration!) {
        viewer {
          assignedIssues(first: 100, filter: { updatedAt: { gte: $updatedAt } }) {
            nodes {
              id
              identifier
              title
              updatedAt
              priority
              ${STATE_BLOCK}
              ${ASSIGNEE_BLOCK}
              ${TEAM_BLOCK}
              project { id name }
            }
          }
        }
      }
    `,
    { updatedAt: since }
  );

  return data.viewer.assignedIssues.nodes;
}

interface DelegatedIssuesResponse {
  issues: {
    nodes: Issue[];
  };
}

export async function getMyQueue(projectName?: string, options?: { includeBacklog?: boolean }): Promise<Issue[]> {
  const self = await getSelfUser();
  // Managing is stewardship state, not actionable work — keep it out of the
  // queue (and `--next`) so it doesn't surface as "what should I do now."
  const stateFilter = options?.includeBacklog
    ? 'state: { type: { nin: ["completed", "canceled", "started"] }, name: { neq: "Managing" } }'
    : 'state: { type: { nin: ["completed", "canceled", "started"] }, name: { nin: ["Backlog", "Managing"] } }';
  const data = await linearGraphQL<DelegatedIssuesResponse>(
    `
      query MyQueue($delegateId: ID!) {
        issues(first: 100, filter: {
          delegate: { id: { eq: $delegateId } },
          ${stateFilter}
        }) {
          nodes {
            id
            identifier
            title
            updatedAt
            priority
            ${STATE_BLOCK}
            ${ASSIGNEE_BLOCK}
            ${DELEGATE_BLOCK}
            ${TEAM_BLOCK}
            project { id name }
          }
        }
      }
    `,
    { delegateId: self.id }
  );

  let issues = data.issues.nodes;

  if (projectName) {
    issues = issues.filter((issue) =>
      issue.project?.name?.toLowerCase().includes(projectName.toLowerCase())
    );
  }

  // Sort: priority asc (0/null=no priority treated as lowest=5), then updatedAt desc
  issues.sort((a, b) => {
    const pa = !a.priority || a.priority === 0 ? 5 : a.priority;
    const pb = !b.priority || b.priority === 0 ? 5 : b.priority;
    if (pa !== pb) return pa - pb;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });

  return issues;
}

/**
 * Issues in the Managing workflow state delegated to the current viewer.
 * These are stewardship tickets — parent / externally-blocked work the agent
 * owns but cannot push forward right now. The Linear Connector wakes the
 * agent on a cadence to re-review.
 */
export async function getMyManaging(): Promise<Issue[]> {
  const self = await getSelfUser();
  const data = await linearGraphQL<DelegatedIssuesResponse>(
    `
      query MyManaging($delegateId: ID!) {
        issues(first: 100, filter: {
          delegate: { id: { eq: $delegateId } },
          state: { name: { eq: "Managing" } }
        }) {
          nodes {
            id
            identifier
            title
            updatedAt
            priority
            ${STATE_BLOCK}
            ${ASSIGNEE_BLOCK}
            ${DELEGATE_BLOCK}
            ${TEAM_BLOCK}
            project { id name }
          }
        }
      }
    `,
    { delegateId: self.id }
  );
  const issues = data.issues.nodes;
  issues.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return issues;
}

export async function findUserByName(name: string): Promise<{ id: string; name: string; email?: string | null; app?: boolean | null }> {
  const data = await linearGraphQL<SearchUsersResponse>(
    `
      query SearchUsers($query: String!) {
        users(first: 50, filter: { name: { containsIgnoreCase: $query } }) {
          nodes {
            id
            name
            email
            app
          }
        }
      }
    `,
    { query: name }
  );

  const exact = data.users.nodes.find((user) => user.name.toLowerCase() === name.toLowerCase());
  if (exact) {
    return exact;
  }

  if (data.users.nodes.length === 1) {
    return data.users.nodes[0];
  }

  // Build hint with fuzzy matches or known user suggestions
  const candidates = data.users.nodes.map((u) => u.name);
  const parts: string[] = [`Could not uniquely resolve Linear user "${name}".`];

  if (candidates.length === 0) {
    parts.push(`No users match "${name}". Check spelling.`);
  } else {
    parts.push(`Possible matches: ${candidates.join(", ")}`);
  }

  throw new Error(parts.join(" "));
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/**
 * Resolve a user reference that may be either a UUID or a display name.
 * UUIDs are passed through directly; names are resolved via findUserByName.
 */
export async function resolveUserRef(ref: string): Promise<string> {
  if (UUID_RE.test(ref)) {
    return ref;
  }
  return (await findUserByName(ref)).id;
}

/**
 * Levenshtein-style simple fuzzy match: returns names within edit distance 2.
 */
function fuzzyNames(query: string, candidates: string[]): string[] {
  const q = query.toLowerCase();
  return candidates.filter((c) => {
    const cl = c.toLowerCase();
    if (cl === q) return false;
    // Simple: starts with same 3 chars, or edit distance heuristic via substring
    if (cl.length >= 3 && q.length >= 3 && cl.startsWith(q.slice(0, 3))) return true;
    if (cl.includes(q) || q.includes(cl)) return true;
    // Simple Levenshtein for short names
    if (Math.abs(cl.length - q.length) <= 2) {
      let diff = 0;
      const max = Math.max(cl.length, q.length);
      for (let i = 0; i < max && diff <= 2; i++) {
        if (cl[i] !== q[i]) diff++;
      }
      if (diff <= 2) return true;
    }
    return false;
  });
}

// Known agent names for hinting (display names used in Linear)
const KNOWN_AGENTS = ["Charles (CTO)", "Astrid (CPO)", "Felix (Unity Dev)", "Noah (React Native Dev)", "Igor (Backend Dev)", "Hanzo (Repo Manager)"];

/**
 * Enhanced user resolution with contextual hints.
 * Wraps findUserByName to add helpful suggestions when resolution fails.
 */
export async function resolveUserWithHints(name: string, contextCommand?: string): Promise<{ id: string; name: string; email?: string | null; app?: boolean | null }> {
  try {
    // UUID passthrough — skip API call
    if (UUID_RE.test(name)) {
      return { id: name, name };
    }
    return await findUserByName(name);
  } catch (err) {
    if (!(err instanceof Error)) throw err;

    // Only enhance resolution errors from findUserByName — pass through network/auth errors unchanged
    if (!err.message.startsWith('Could not uniquely resolve')) {
      throw err;
    }

    const parts = [err.message];

    // If no matches at all, try fuzzy suggestions
    const allNames: string[] = [...KNOWN_AGENTS];
    const fuzzy = fuzzyNames(name, allNames);
    if (fuzzy.length > 0) {
      parts.push(`Did you mean: ${fuzzy.join(", ")}?`);
    }

    // If the name looks human and command is an agent command, suggest human variant
    const humanCommands = ["handoff-work", "refuse-work", "needs-human", "consider-work", "begin-work"];
    const isAgentLike = KNOWN_AGENTS.some((a) => a.toLowerCase().includes(name.toLowerCase()));
    if (!isAgentLike && contextCommand && humanCommands.includes(contextCommand) && contextCommand !== "needs-human") {
      parts.push(`If ${name} is a human, consider using 'needs-human' instead.`);
    }

    // For create context, hint about UUID requirement if name doesn't match
    if (contextCommand === "create" && !isAgentLike) {
      parts.push(`Tip: use 'linear create --assignee "Display Name"' with the exact Linear display name, or pass a UUID directly.`);
    }

    throw new Error(parts.join(" "));
  }
}

interface VerifyCommentResponse {
  comment: {
    id: string;
    body: string;
    createdAt: string;
    url: string;
    issue: { identifier: string } | null;
  } | null;
}

export async function verifyComment(commentId: string): Promise<{
  commentId: string;
  exists: boolean;
  body?: string;
  createdAt?: string;
  issueIdentifier?: string;
  url?: string;
}> {
  const data = await linearGraphQL<VerifyCommentResponse>(
    `
      query VerifyComment($id: String!) {
        comment(id: $id) {
          id
          body
          createdAt
          url
          issue { identifier }
        }
      }
    `,
    { id: commentId }
  );

  if (!data.comment) {
    return { commentId, exists: false };
  }

  return {
    commentId: data.comment.id,
    exists: true,
    body: data.comment.body,
    createdAt: data.comment.createdAt,
    issueIdentifier: data.comment.issue?.identifier ?? undefined,
    url: data.comment.url
  };
}
