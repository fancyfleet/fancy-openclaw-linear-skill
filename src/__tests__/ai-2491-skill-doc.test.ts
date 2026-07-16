/**
 * AI-2491 — AC 4: the linear skill doc's "Comment Verification" section is
 * updated to mention both commands alongside `verify-comment`.
 *
 * The doc is the delivery mechanism for the whole ticket. The commands exist so
 * agents stop reaching for `observe-issue` to verify a mutation — an agent that
 * never learns they exist keeps making the mistake, and the code change buys
 * nothing. So the doc AC is load-bearing, not paperwork.
 *
 * Assertions target the section, not the whole file: a passing mention of
 * `read-state` in some unrelated command list further down would not tell an
 * agent standing at the verification decision point what to reach for.
 */

import fs from "node:fs";
import path from "node:path";

const SKILL_PATH = path.join(__dirname, "..", "..", "SKILL.md");

/**
 * Extract the "Comment Verification" section: from its heading to the next
 * heading of the same or shallower depth. Mirrors the extraction approach in
 * skill-doc-cross-agent.test.ts (AI-1767).
 */
function extractCommentVerificationSection(doc: string): string {
  const headingMatch = doc.match(/^#{2,3}\s+Comment Verification\s*$/m);
  if (!headingMatch || headingMatch.index === undefined) {
    throw new Error(
      'AI-2491 AC4: expected a "Comment Verification" section heading in SKILL.md'
    );
  }

  const start = headingMatch.index;
  const rest = doc.slice(start + headingMatch[0].length);
  const nextHeading = rest.search(/^#{1,3}\s+/m);

  return nextHeading < 0 ? doc.slice(start) : doc.slice(start, start + headingMatch[0].length + nextHeading);
}

describe("AI-2491: SKILL.md Comment Verification documents the read commands (AC 4)", () => {
  const doc = fs.readFileSync(SKILL_PATH, "utf8");

  it("mentions read-state in the Comment Verification section", () => {
    const section = extractCommentVerificationSection(doc);
    expect(section).toContain("read-state");
  });

  it("mentions read-last-comment in the Comment Verification section", () => {
    const section = extractCommentVerificationSection(doc);
    expect(section).toContain("read-last-comment");
  });

  it("still documents verify-comment — the new commands sit alongside it, not replace it", () => {
    const section = extractCommentVerificationSection(doc);
    expect(section).toContain("verify-comment");
  });

  it("frames the read commands themselves as strongly-consistent, not just verify-comment", () => {
    const section = extractCommentVerificationSection(doc);

    // The section ALREADY says "strongly-consistent" about verify-comment, so a
    // bare section-wide match would pass without the AC being met. Assert the
    // framing attaches to the new commands: the prose introducing read-state /
    // read-last-comment must itself carry the consistency rationale, or the
    // agent's observe-issue habit survives the doc update.
    const mentionLines = section
      .split(/(?<=[.\n])/)
      .filter((chunk) => /read-state|read-last-comment/.test(chunk));

    expect(mentionLines.length).toBeGreaterThan(0);

    const mentionProse = mentionLines.join(" ");
    expect(mentionProse).toMatch(/strongly[- ]consistent|node query/i);
  });
});
