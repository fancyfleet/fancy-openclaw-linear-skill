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
 * This CLI verb is a **thin, taxonomy-free trigger**. It attaches the `wf:<id>`
 * label at `issueCreate` time (`issueCreate` is not intercepted by the proxy's
 * raw-mutation gate — only `issueUpdate`/`commentCreate` are) and nothing else.
 * It does NOT know which workflows exist: there is no allowlist, no registry
 * lookup, no per-workflow branch. That was deliberately removed — an allowlist
 * re-bakes the workflow taxonomy into the tool.
 *
 * Validation of `<id>` against the workflow registry belongs to the engine,
 * which is the single source of truth for what workflows exist. The connector's
 * `applyBootstrapToIssue` hook sees the pre-attached `wf:*` label on the create
 * webhook (for a create event `previousLabelIds` is empty, so every current
 * label counts as "added"), resolves `<id>` against `loadWorkflowRegistry()`,
 * and either:
 *   - stamps `state:<entry_state>` + the entry state's owner delegate (registered), or
 *   - loudly rejects the ticket back to its requester with an
 *     "unknown workflow '<id>' — not registered" comment (unregistered).
 *
 * So a typo here does not silently strand a ticket: it produces an auditable
 * rejection at the engine. The CLI's only job is to attach the label.
 */

/**
 * Normalize a `--workflow` value to the `wf:<id>` label name to attach at
 * creation. Accepts either the bare id (`dev-impl`) or the label form
 * (`wf:dev-impl`), stripping a leading `wf:` prefix case-insensitively and
 * trimming surrounding whitespace.
 *
 * The id itself is preserved verbatim (not lowercased): the engine matches it
 * against the registry exactly, so the CLI must not silently transform what the
 * caller typed. The only rejection here is a structurally-empty value, which
 * could not form a valid label — everything else is the engine's call.
 */
export function resolveWorkflowLabelName(workflowInput: string): string {
  const id = workflowInput.trim().replace(/^wf:/i, "").trim();
  if (!id) {
    throw new Error("--workflow requires a workflow id (e.g. dev-impl).");
  }
  return `wf:${id}`;
}
