/**
 * INF-552: authoring path for standalone workflow tickets via `linear create --workflow`.
 *
 * New tickets default to `wf:task` (intake→routing→doing→review→sign-off→done —
 * NO deploy gate). Connector code fixes that require merge+deploy to take effect
 * were therefore filed as `wf:task` with hand-written "don't close at merge /
 * deploy is what closes this" admonitions, because no create path could author a
 * standalone `wf:dev-impl` ticket and relabeling afterward is proxy-blocked
 * ("Direct label changes are blocked on this workflow ticket").
 *
 * ## Why the CLI cannot attach `wf:<id>` directly
 *
 * The first cut of this verb pre-attached a `wf:<id>` label at `issueCreate`,
 * find-or-creating it on the team. That worked for REGISTERED workflows only —
 * because those `wf:*` labels already existed, so the find succeeded. For an
 * unregistered (or simply not-yet-provisioned) id the create leg failed: an
 * agent OAuth actor token **cannot create IssueLabels** (Linear returns 400), so
 * the id never reached the engine's registry validation and the ticket failed
 * opaquely at the CLI — the exact "Label not found" outcome find-or-create was
 * meant to avoid. See INF-552 review (Astrid, 2026-07-24).
 *
 * ## The channel: sentinel label + description marker
 *
 * The engine — the connector's `applyBootstrapToIssue` — is the single source of
 * truth for what workflows exist, and (unlike the CLI) it CAN create labels. So
 * this verb stays a thin, taxonomy-free trigger and hands the engine the id
 * through a channel the CLI is allowed to write:
 *
 *   - it attaches the single, pre-provisioned `wf:pending` sentinel label
 *     (`WF_PENDING_LABEL`) — one fixed marker that encodes no workflow taxonomy,
 *     only "a workflow was requested and is pending engine resolution"; and
 *   - it embeds the verbatim requested id in a `<!-- openclaw:workflow-request
 *     id="<id>" -->` marker appended to the description.
 *
 * The connector's bootstrap sees `wf:pending`, reads the marker, resolves the id
 * against `loadWorkflowRegistry()`, and either swaps the sentinel for the
 * concrete `wf:<id>` label + stamps `state:<entry_state>` (registered), or
 * loudly rejects the ticket back to its requester with an "unknown workflow
 * '<id>' — not registered" comment (unregistered). No allowlist, no registry
 * lookup, and no `wf:<id>` label creation live here by design — a typo produces
 * an auditable engine rejection, not a CLI-side gate on label existence.
 */

/** The single, taxonomy-free sentinel label the CLI attaches for authoring. */
export const WF_PENDING_LABEL = "wf:pending";

/**
 * Normalize a `--workflow` value to the bare workflow id the engine resolves
 * against the registry. Accepts either the bare id (`dev-impl`) or the label
 * form (`wf:dev-impl`), stripping a leading `wf:` prefix case-insensitively and
 * trimming surrounding whitespace.
 *
 * The id itself is preserved verbatim (not lowercased): the engine matches it
 * against the registry exactly, so the CLI must not silently transform what the
 * caller typed. The only rejection here is a structurally-empty value, which
 * could not name a workflow — everything else is the engine's call.
 */
export function normalizeWorkflowId(workflowInput: string): string {
  const id = workflowInput.trim().replace(/^wf:/i, "").trim();
  if (!id) {
    throw new Error("--workflow requires a workflow id (e.g. dev-impl).");
  }
  return id;
}

/**
 * Build the description marker that carries the verbatim requested workflow id
 * to the engine. An HTML comment so it is invisible in rendered Markdown. Kept
 * byte-identical to the connector's `WORKFLOW_REQUEST_MARKER_RE` parser.
 */
export function buildWorkflowRequestMarker(workflowId: string): string {
  return `<!-- openclaw:workflow-request id="${workflowId}" -->`;
}

/**
 * Append the workflow-request marker to a (possibly empty) description, so the
 * engine can read the requested id off the created ticket. Separated from any
 * existing body by a blank line; when there is no body, the marker stands alone.
 */
export function appendWorkflowRequestMarker(
  description: string | undefined,
  workflowId: string,
): string {
  const marker = buildWorkflowRequestMarker(workflowId);
  const body = description?.trim();
  return body ? `${body}\n\n${marker}` : marker;
}
