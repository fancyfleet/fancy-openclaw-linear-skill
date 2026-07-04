/**
 * AI-1767 — AC 2 (doc path): SKILL.md must accurately describe the
 * cross-agent upload limitation and name the sanctioned workaround.
 *
 * The current SKILL.md asserts that uploads are "served behind the same
 * Linear API token the CLI already uses for GraphQL" — which is false when
 * the upload was created by a different OAuth app. This test verifies the
 * doc is corrected.
 */

import fs from "node:fs";
import path from "node:path";

const SKILL_PATH = path.join(__dirname, "..", "..", "SKILL.md");

function readSkillDoc(): string {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

describe("AI-1767: SKILL.md cross-agent upload documentation (AC 2)", () => {
  const doc = readSkillDoc();

  // The "Reading Image / File Attachments" section must acknowledge that
  // cross-agent uploads may 401.
  it("mentions cross-agent or cross-app upload limitation in the fetch-image section", () => {
    // Extract the section around "uploads.linear.app" or "fetch-image"
    const sectionStart = doc.indexOf("Reading Image");
    const sectionEnd = doc.indexOf("##", sectionStart + 1);
    const section = sectionStart >= 0 && sectionEnd > sectionStart
      ? doc.slice(sectionStart, sectionEnd)
      : doc;

    expect(section).toMatch(/cross-agent|cross-app|different agent|another agent/i);
  });

  it("documents a sanctioned workaround for cross-agent uploads", () => {
    const sectionStart = doc.indexOf("Reading Image");
    const sectionEnd = doc.indexOf("##", sectionStart + 1);
    const section = sectionStart >= 0 && sectionEnd > sectionStart
      ? doc.slice(sectionStart, sectionEnd)
      : doc;

    // The workaround should name something actionable: fetch from the
    // uploading agent, use a shared path, or similar.
    expect(section).toMatch(/workaround|uploading agent|uploader|same agent|shared/i);
  });

  it("no longer claims uploads are always readable behind the same token", () => {
    const sectionStart = doc.indexOf("Reading Image");
    const sectionEnd = doc.indexOf("##", sectionStart + 1);
    const section = sectionStart >= 0 && sectionEnd > sectionStart
      ? doc.slice(sectionStart, sectionEnd)
      : doc;

    // The unqualified claim "served behind the same Linear API token" must be
    // gone or qualified with a cross-agent caveat.
    const oldClaim = /same Linear API token the CLI already uses/i;
    if (oldClaim.test(section)) {
      // If the old phrasing remains, it must be immediately followed by a
      // cross-agent qualification.
      const matchIdx = section.search(oldClaim);
      const afterClaim = section.slice(matchIdx, matchIdx + 300);
      expect(afterClaim).toMatch(/cross-agent|cross-app|different.*agent|except|unless|caveat|limitation/i);
    }
    // If the old claim is gone entirely, this test passes unconditionally.
  });
});
