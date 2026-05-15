/**
 * Shared GraphQL field selection strings.
 *
 * These are NOT named GraphQL fragments — they are plain template strings
 * interpolated into queries via `${FRAGMENT}`. This keeps the existing
 * query pattern unchanged while eliminating duplication.
 */

export const ASSIGNEE_FIELDS = `
  id
  name
  email
`;

/** Delegate has the same shape as assignee */
export const DELEGATE_FIELDS = ASSIGNEE_FIELDS;

export const STATE_FIELDS = `
  id
  name
  type
`;

export const STATE_DETAIL_FIELDS = `
  id
  name
  type
  color
  position
`;

export const TEAM_FIELDS = `
  id
  key
  name
`;

export const COMMENT_USER_FIELDS = `
  id
  name
  email
  app
`;

export const COMMENT_FIELDS = `
  id
  body
  createdAt
  updatedAt
  user {
    ${COMMENT_USER_FIELDS}
  }
`;

export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  createdAt
  updatedAt
  team {
    ${TEAM_FIELDS}
  }
  state {
    ${STATE_DETAIL_FIELDS}
  }
  assignee {
    ${ASSIGNEE_FIELDS}
  }
  delegate {
    ${DELEGATE_FIELDS}
  }
  project {
    id
    name
  }
  projectMilestone {
    id
    name
    description
    targetDate
  }
  labels {
    nodes {
      id
      name
      color
    }
  }
  parent {
    id
    identifier
    title
  }
  children {
    nodes {
      id
      identifier
      title
      state {
        ${STATE_FIELDS}
        color
      }
    }
  }
  relations {
    nodes {
      id
      type
      issue {
        id
        identifier
        title
      }
      relatedIssue {
        id
        identifier
        title
      }
    }
  }
  comments(last: 50, orderBy: createdAt) {
    nodes {
      ${COMMENT_FIELDS}
    }
  }
`;

/** Wrapped versions for inline use in list/board queries */
export const STATE_BLOCK = `state { ${STATE_FIELDS} }`;
export const ASSIGNEE_BLOCK = `assignee { ${ASSIGNEE_FIELDS} }`;
export const DELEGATE_BLOCK = `delegate { ${DELEGATE_FIELDS} }`;
export const TEAM_BLOCK = `team { ${TEAM_FIELDS} }`;

/** Alias for backward compat with existing import in issues.ts */
export { ISSUE_FIELDS as ISSUE_FIELDS_FRAGMENT };
