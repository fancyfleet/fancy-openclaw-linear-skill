export interface User {
  id: string;
  name: string;
  email?: string | null;
  /** Optional on integrations that can distinguish bot/agent users. */
  isAgent?: boolean | null;
  /** Linear's current bot/application user flag; used as an agent fallback. */
  app?: boolean | null;
}

export interface WorkflowState {
  id: string;
  name: string;
  type?: string | null;
  color?: string | null;
  position?: number | null;
}

export interface Comment {
  id: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  user?: User | null;
}

/**
 * Single record in an issue's history. Each record describes one or more
 * field changes recorded by Linear. Use the `from*`/`to*` fields to detect
 * which changes happened.
 */
export interface IssueHistory {
  createdAt: string;
  actor: { name: string } | null;
  fromState: { name: string } | null;
  toState: { name: string } | null;
  fromAssignee: { name: string } | null;
  toAssignee: { name: string } | null;
  fromDelegate: { name: string } | null;
  toDelegate: { name: string } | null;
  fromPriority: number | null;
  toPriority: number | null;
}

export interface ProjectMilestone {
  id: string;
  name: string;
  description?: string | null;
  targetDate?: string | null;
}

export interface IssueRelation {
  id: string;
  type?: string | null;
  issue: Pick<Issue, "id" | "identifier" | "title">;
  relatedIssue: Pick<Issue, "id" | "identifier" | "title">;
}

/**
 * Which side of the relation the issue you asked about sits on.
 * `outbound` — it is `relation.issue`; `inbound` — it is `relation.relatedIssue`.
 */
export type RelationDirection = "outbound" | "inbound";

/**
 * A relation resolved from the perspective of a specific issue.
 *
 * Linear stores each relation once, as a directed edge. `type` alone is therefore
 * ambiguous to a reader: a `blocks` edge means "I block them" or "they block me"
 * depending on which end you asked from. `relation` resolves that into a label
 * that reads correctly for the issue that was queried.
 */
export interface AnnotatedIssueRelation extends IssueRelation {
  direction: RelationDirection;
  /** `type` restated from the queried issue's point of view, e.g. `blocked-by`. */
  relation: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  content?: string | null;
  state?: string | null;
  progress?: number | null;
  targetDate?: string | null;
  startDate?: string | null;
  projectMilestones?: ProjectMilestone[];
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  url?: string;
  team?: {
    id: string;
    key?: string;
    name?: string;
  } | null;
  state?: WorkflowState | null;
  assignee?: User | null;
  delegate?: User | null;
  project?: {
    id: string;
    name: string;
  } | null;
  milestone?: ProjectMilestone | null;
  labels?: Array<{
    id: string;
    name: string;
    color?: string | null;
  }>;
  parent?: Pick<Issue, "id" | "identifier" | "title"> | null;
  children?: Array<Pick<Issue, "id" | "identifier" | "title"> & { state?: WorkflowState | null }>;
  /** Edges where this issue is the source. */
  relations?: IssueRelation[];
  /** Edges where this issue is the target — where its own blockers live. */
  inverseRelations?: IssueRelation[];
  comments?: Comment[];
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description?: string;
  projectId?: string;
  projectMilestoneId?: string;
  assigneeId?: string;
  delegateId?: string;
  priority?: number;
  parentId?: string;
  stateId?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  stateId?: string;
  assigneeId?: string | null;
  delegateId?: string | null;
  priority?: number;
  projectId?: string;
  projectMilestoneId?: string;
  parentId?: string | null;
  teamId?: string;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
}
