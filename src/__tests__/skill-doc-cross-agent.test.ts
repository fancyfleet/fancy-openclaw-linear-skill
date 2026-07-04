/**
 * AI-1767 — AC 2: SKILL.md must accurately describe the proxy-routed fetch
 * behavior.
 *
 * Root cause (confirmed during AC validation): agent containers hold `lpx_`
 * proxy tokens, not real Linear OAuth tokens. The fix routes fetch-image
 * through the connector proxy, which swaps in real credentials. SKILL.md
 * must not claim a cross-agent limitation that doesn't exist.
 */

import fs from "node:fs";
import path from "node:path";

const SKILL_PATH = path.join(__dirname, "..", "..", "SKILL.md");

function readSkillDoc(): string {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

function extractFetchImageSection(doc: string): string {
  const sectionStart = doc.indexOf("Reading Image");
  if (sectionStart < 0) return doc;
  const sectionEnd = doc.indexOf("\n## ", sectionStart + 1);
  return sectionEnd > sectionStart ? doc.slice(sectionStart, sectionEnd) : doc.slice(sectionStart);
}

describe("AI-1767: SKILL.md fetch-image documentation (AC 2)", () => {
  const doc = readSkillDoc();

  it("does not claim cross-agent uploads are unreadable (that was the wrong root cause)", () => {
    const section = extractFetchImageSection(doc);

    // The false claim: "uploads created by one agent's OAuth app are not
    // readable by another agent's token." This was disproven — the real issue
    // was proxy token vs real token, not cross-agent scoping.
    expect(section).not.toMatch(/cross-agent.*not.*readable|not readable.*another agent/i);
    expect(section).not.toMatch(/cross-agent limitation/i);
  });

  it("documents the proxy-routed fetch behavior or does not mislead about token usage", () => {
    const section = extractFetchImageSection(doc);

    // The doc should either mention the proxy, or at minimum not claim uploads
    // are served behind "the same token" unqualified.
    const mentionsProxy = /proxy/i.test(section);
    const hasQualifiedTokenClaim = /same.*token.*when|same.*token.*proxy|routed through/i.test(section);

    expect(mentionsProxy || hasQualifiedTokenClaim).toBe(true);
  });

  it("mentions that fetch-image works transparently (no manual workaround needed)", () => {
    const section = extractFetchImageSection(doc);

    // The doc should not present a manual workaround for fetching — the proxy
    // routing is automatic. Either it mentions the proxy, or it simply
    // documents the command as working without caveats about cross-agent.
    const hasNoFalseWorkaround = !/workaround.*uploading agent|workaround.*same agent/i.test(section);
    expect(hasNoFalseWorkaround).toBe(true);
  });
});
