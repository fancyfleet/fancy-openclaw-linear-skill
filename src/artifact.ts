/**
 * AI-2479 — code-artifact disclosure records.
 *
 * A handoff may declare the code artifact it is about as `<branch>@<sha>`. The
 * declaration is written into the handoff comment as an HTML-comment marker so
 * that it lives in the ticket timeline: auditable, readable back by the
 * connector, and — unlike either of the connector's in-process stores — able to
 * survive a restart and the days that can separate a handoff from its review.
 *
 * The marker records the artifact and the RECIPIENT — never the declaring agent.
 * Author identity is resolved connector-side from the OAuth token, which the
 * caller cannot forge; a self-reported author in the marker would be an honour
 * system with extra steps — the same defect that moved this ticket off the
 * git-author check in the first place.
 *
 * `to` is the obligation's address, and it is what makes the guard targetable.
 * A declaration means "I hand YOU this code"; only that recipient owes a
 * disclosure when they hand the ticket onward. Without `to`, the connector can
 * only key on "a declaration exists somewhere on this ticket", which fires on
 * unrelated third parties who were handed nothing and reviewed nothing (Ai's
 * AI-2479 refusal: an unrelated re-route was blocked, and its only escape was to
 * name an artifact the caller never reviewed — teaching exactly the reflex this
 * ticket exists to punish).
 *
 * `to` is written by the declaring agent, so a wrong value disarms the guard on
 * that handoff. That is NOT a new hole: the declaration is opt-in, so an agent
 * who wants no guard already just omits --code-artifact. It cannot be used to
 * launder a substitution either — the connector ignores markers authored by the
 * caller, so you cannot re-address an obligation to yourself to clear it.
 *
 * Naming: `--code-artifact` is deliberately distinct from the pre-existing
 * `--artifact-ref` / `X-Openclaw-Artifact-Ref` surface (AI-1472), which binds a
 * sprint-plan *vault path* at `intake.accept` for `canonical-sprint`. Different
 * concept, different lifetime; sharing a name would mislead every future reader.
 */

/** A declared code artifact: a branch and the commit on it under discussion. */
export interface CodeArtifact {
  branch: string;
  sha: string;
}

/**
 * A recorded declaration read back off the ticket: the artifact, plus the Linear
 * user id of the agent it was handed to. `to` is the party that owes a
 * disclosure at their next handoff.
 */
export interface ArtifactRecord extends CodeArtifact {
  to: string;
}

const MARKER_PREFIX = "<!-- artifact-disclosure: ";
const MARKER_SUFFIX = " -->";

/**
 * Matches a marker anywhere in a comment body. Non-greedy so that a body with
 * more than one marker yields each separately rather than one giant span.
 */
const MARKER_RE = /<!--\s*artifact-disclosure:\s*(\{.*?\})\s*-->/g;

/** A 7-40 char hex commit sha — abbreviated or full. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Parse a `<branch>@<sha>` operand.
 *
 * Splits on the LAST `@` so branch names containing `@` survive. Throws with an
 * actionable message rather than returning null — every caller is a CLI entry
 * point that wants to fail loudly before mutating anything.
 */
export function parseCodeArtifact(operand: string): CodeArtifact {
  const trimmed = operand.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error(
      `--code-artifact must be '<branch>@<sha>' (e.g. feature/AI-2479-guard@c81dfe0); got '${operand}'.`
    );
  }
  const branch = trimmed.slice(0, at).trim();
  const sha = trimmed.slice(at + 1).trim();
  if (!branch) {
    throw new Error(`--code-artifact is missing a branch before '@'; got '${operand}'.`);
  }
  if (!SHA_RE.test(sha)) {
    throw new Error(
      `--code-artifact sha must be 7-40 hex characters; got '${sha}'. ` +
      `Use the commit sha, not a tag or branch name.`
    );
  }
  return { branch, sha: sha.toLowerCase() };
}

/** Render an artifact back to its `<branch>@<sha>` operand form, for messages. */
export function formatCodeArtifact(a: CodeArtifact): string {
  return `${a.branch}@${a.sha}`;
}

/**
 * Build the HTML-comment marker for a comment body.
 *
 * Callers must append this to the body only AFTER near-duplicate detection has
 * run, so a marker never makes two otherwise-identical comments look distinct.
 */
export function buildArtifactMarker(a: CodeArtifact, to: string): string {
  return `${MARKER_PREFIX}${JSON.stringify({ branch: a.branch, sha: a.sha, to })}${MARKER_SUFFIX}`;
}

/**
 * Extract every artifact marker from a comment body, in document order.
 *
 * A malformed marker is skipped rather than thrown on: this parses untrusted
 * historical comment bodies, and one bad marker must not make a ticket
 * permanently ungateable.
 *
 * The sha is validated with the SAME `SHA_RE` the write path enforces. Reading
 * laxer than you write is how a comparison quietly stops comparing: comment
 * bodies are agent-writable, `shasMatch` prefix-compares on the shorter operand,
 * and so a recorded sha of `"9"` would have matched EVERY declared sha starting
 * with 9 (Ai's AI-2479 refusal). A record whose sha cannot be a sha is not a
 * weaker record — it is not a record, and is dropped.
 *
 * A marker without a `to` is likewise dropped: it names an obligation with no
 * one to owe it, and firing on it is the unaddressed-guard bug. No such marker
 * can exist in the wild — nothing has shipped — so this is strictness with no
 * migration to pay for.
 */
export function parseArtifactMarkers(body: string): ArtifactRecord[] {
  const out: ArtifactRecord[] = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(body)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as Partial<ArtifactRecord>;
      if (typeof parsed.branch !== "string" || !parsed.branch) continue;
      if (typeof parsed.sha !== "string" || !SHA_RE.test(parsed.sha)) continue;
      if (typeof parsed.to !== "string" || !parsed.to) continue;
      out.push({ branch: parsed.branch, sha: parsed.sha.toLowerCase(), to: parsed.to });
    } catch {
      // Malformed payload — ignore this marker, keep scanning.
    }
  }
  return out;
}

/** True when two artifacts name the same commit on the same branch. */
export function sameArtifact(a: CodeArtifact, b: CodeArtifact): boolean {
  return a.branch === b.branch && shasMatch(a.sha, b.sha);
}

/**
 * Compare two shas allowing for abbreviation: `c81dfe0` and its 40-char form are
 * the same commit. Prefix-compare on the shorter, which is what `git` itself
 * does. Both are hex-validated at parse time, so a prefix match here cannot be
 * satisfied by arbitrary text.
 */
export function shasMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  return longer.startsWith(shorter);
}
