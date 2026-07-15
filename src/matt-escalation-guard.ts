import fs from "node:fs/promises";
import path from "node:path";

export interface MattEscalationRefusal {
  category: string;
  matchedText: string;
}

interface RefusalPattern {
  category: string;
  /** Strong signals: unambiguous intent — always trip, regardless of context. */
  patterns: RegExp[];
  /**
   * Weak signals: tokens (a bare `401`, a lone `re-authenticate`) that are only
   * escalation-worthy when they describe the agent's *own* broken auth. They are
   * suppressed when `suppressContext` matches near the token, because there the
   * same token is a verification/forensic signal (the desired outcome), not a
   * failure being routed to Matt. See AI-2390.
   */
  weakPatterns?: RegExp[];
  /**
   * Allowlist gate for weak patterns: when set, a weak token trips *only* if
   * this context matches within the proximity window. Used for categories whose
   * weak tokens are neutral narrative verbs (`refresh…token`, `rotate…credential`)
   * that appear constantly in runbooks/post-incident reports with zero intent to
   * route anything to Matt — so mere presence must not trip. The escalation
   * signal is a Matt-directed request / auth-failure intent co-occurring with the
   * token. Optional: gh-auth omits it (its weak tokens are inherently failure
   * signals, so it defaults to trip and only suppresses). See AI-2393.
   */
  requireContext?: RegExp;
  suppressContext?: RegExp;
}

/**
 * Verification / forensic phrasing. When one of these sits next to a weak
 * gh-auth token, the token is describing a *checked or expected* outcome
 * ("verify the revoked token is rejected (401)"), not the agent's auth failing.
 * Scoped by proximity in `checkMattEscalation`, so a "verify" elsewhere in a
 * long comment cannot mask a genuine "gh auth is broken" sentence. (AI-2390)
 */
const GH_AUTH_VERIFICATION_CONTEXT =
  /\b(verif(?:y|ies|ied|ying)|confirm(?:s|ed|ing)?|proof|prov(?:e[ds]?|ing)|expect(?:s|ed|ing)?|reject(?:s|ed|ing)?|revoke[ds]?|revoking|rotat(?:e[ds]?|ing|ion)|as\s+expected|should\s+(?:return|be|get|fail)|now\s+returns?|is\s+(?:dead|rejected|revoked)|leaked|fingerprint|forensic|quote[ds]?)\b/i;

/**
 * credential-rotation intent allowlist (AI-2393). The weak rotation tokens are
 * neutral narrative verbs; they only escalate when a Matt-directed request OR the
 * agent's-own-auth-failure is expressed near them. Polarity is deliberately the
 * inverse of gh-auth (trip-only-on-intent, not trip-unless-verification) because
 * the base rate differs: rotation vocabulary is common in write-ups, `401` is not.
 */
const CREDENTIAL_ROTATION_INTENT_CONTEXT =
  /\b(please|need\s+(?:to|you|someone|him|matt)|can\s+you|could\s+you|would\s+you|have\s+to|has\s+to|must\b|expired|invalid|broken|failing|failed|denied|unauthorized|no\s+longer\s+work(?:s|ing)?|stopped\s+working)\b/i;

/**
 * credential-rotation verification/forensic suppress (AI-2393). Same intent as
 * GH_AUTH_VERIFICATION_CONTEXT but deliberately EXCLUDES `rotat*`/`refresh`/
 * `token`/`credential`: reusing gh-auth's set wholesale would self-suppress on
 * the category's own weak tokens (its regex contains a `rotat…` alternative) and
 * neuter it. Applied after the intent gate: trip iff intent present AND
 * verification absent — so "I refreshed the token and need you to confirm the old
 * one is dead" (intent + `confirm`) does not trip.
 */
const CREDENTIAL_ROTATION_VERIFICATION_CONTEXT =
  /\b(verif(?:y|ies|ied|ying)|confirm(?:s|ed|ing)?|proof|prov(?:e[ds]?|ing)|expect(?:s|ed|ing)?|reject(?:s|ed|ing)?|revoke[ds]?|revoking|as\s+expected|should\s+(?:return|be|get|fail)|now\s+returns?|is\s+(?:dead|rejected|revoked)|leaked|fingerprint|forensic|observed|post-?incident|write-?up|quote[ds]?)\b/i;

/** How far (chars) around a weak match to scan for require/suppress context. */
const SUPPRESS_WINDOW_BEFORE = 90;
const SUPPRESS_WINDOW_AFTER = 48;

const DEFAULT_PATTERNS: RefusalPattern[] = [
  {
    category: "gh-auth",
    patterns: [
      /gh\s+auth/i,
      /gh\s+cli/i,
      /github\s+auth/i,
      /auth.*broken/i,
      /auth.*expired/i,
      /gh\s+auth\s+login/i,
    ],
    weakPatterns: [/\b401\b/, /re-?authenticate/i],
    suppressContext: GH_AUTH_VERIFICATION_CONTEXT,
  },
  {
    category: "pr-action",
    patterns: [
      /open\s+(the|this|a)\s+PR/i,
      /merge\s+(the|this)\s+PR/i,
      /review\s+(the|this)\s+PR/i,
      /PR\s+review/i,
    ],
  },
  {
    category: "ac-verification",
    patterns: [
      /verify\s+(the\s+)?AC\b/i,
      /AC\s+verification/i,
      /verify\s+(the\s+)?acceptance/i,
    ],
  },
  {
    category: "prioritization",
    patterns: [
      /prioriti[sz]e\s+(the\s+)?fix/i,
      /which\s+(one|of\s+these)\s+should/i,
      /fix\s+priority/i,
    ],
  },
  {
    category: "routing",
    patterns: [/which\s+agent/i, /\brouting\b/i, /who\s+owns/i],
  },
  {
    // Weak, intent-gated (AI-2393): rotation vocabulary is neutral narrative and
    // only escalates when a request/auth-failure intent co-occurs and no
    // verification/forensic cue is present. No strong patterns — nothing here is
    // unconditional.
    category: "credential-rotation",
    patterns: [],
    weakPatterns: [/refresh.*token/i, /rotate.*credential/i],
    requireContext: CREDENTIAL_ROTATION_INTENT_CONTEXT,
    suppressContext: CREDENTIAL_ROTATION_VERIFICATION_CONTEXT,
  },
];

function loadEnvPatterns(): RefusalPattern[] {
  const raw = process.env.LINEAR_MATT_REFUSAL_PATTERNS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ category: string; patterns: string[] }>;
    return parsed.map(({ category, patterns }) => ({
      category,
      patterns: patterns.map((p) => new RegExp(p, "i")),
    }));
  } catch {
    process.stderr.write(
      "Warning: LINEAR_MATT_REFUSAL_PATTERNS is not valid JSON — extra patterns ignored.\n"
    );
    return [];
  }
}

export function checkMattEscalation(text: string): MattEscalationRefusal | null {
  const allPatterns = [...DEFAULT_PATTERNS, ...loadEnvPatterns()];
  for (const { category, patterns, weakPatterns, requireContext, suppressContext } of allPatterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return { category, matchedText: match[0] };
      }
    }
    for (const pattern of weakPatterns ?? []) {
      const match = text.match(pattern);
      if (!match) continue;
      if (requireContext && !matchIsContext(text, match, requireContext)) {
        continue; // neutral narrative token with no escalation intent nearby
      }
      if (suppressContext && matchIsContext(text, match, suppressContext)) {
        continue; // token is a verification/forensic signal, not an auth failure
      }
      return { category, matchedText: match[0] };
    }
  }
  return null;
}

/**
 * True when `context` matches within the proximity window around a weak match.
 * Used both as an allowlist gate (`requireContext`) and a suppress gate
 * (`suppressContext`). Only the window around the match is scanned, so distant
 * unrelated wording (a "verify" paragraphs away from a real "gh auth broke")
 * does not affect a genuine failure signal. (AI-2390, generalized AI-2393)
 */
function matchIsContext(
  text: string,
  match: RegExpMatchArray,
  context: RegExp
): boolean {
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - SUPPRESS_WINDOW_BEFORE);
  const end = idx + match[0].length + SUPPRESS_WINDOW_AFTER;
  return context.test(text.slice(start, end));
}

export function isMattTarget(name: string): boolean {
  return /\bmatt\b/i.test(name);
}

export function formatRefusalError(
  issueId: string,
  refusal: MattEscalationRefusal
): string {
  return [
    `MATT_ESCALATION_REFUSED: ${refusal.category}`,
    `Reason "${refusal.matchedText}" matches forbidden category "${refusal.category}".`,
    `See ~/obsidian-vault/governance/escalation-rules.md.`,
    `Default escalation surface is Ai. Use:`,
    `  linear handoff-work ${issueId} "Ai" --comment "[${refusal.category}] <one-line reason>"`,
    `If you genuinely need Matt (external blast / he named you / he's the conversational partner), pass --force-matt-escalation.`,
  ].join("\n");
}

/** Vault-relative location of the escalation pattern log (post-restructure). */
export const ESCALATION_PATTERN_LOG_RELPATH =
  "obsidian-vault/life-os/infra/agents/escalation-pattern-log.md";

export async function logRefusal(
  issueId: string,
  refusal: MattEscalationRefusal,
  forced: boolean
): Promise<void> {
  const home = process.env.HOME ?? "~";
  const logPath = path.join(home, ESCALATION_PATTERN_LOG_RELPATH);
  const timestamp = new Date().toISOString();
  const action = forced ? "FORCE-BYPASS" : "REFUSED";
  const line = `| ${timestamp} | CLI | ${issueId} | ${refusal.category} | \`${refusal.matchedText}\` | ${action} |\n`;
  try {
    // Create the leaf dirs, but only inside an existing vault: on a host with no
    // vault mounted, logging stays a no-op rather than growing a stray tree.
    await fs.access(path.join(home, "obsidian-vault"));
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, line);
  } catch {
    // Log failure is non-fatal
  }
}
