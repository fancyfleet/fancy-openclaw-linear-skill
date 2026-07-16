/**
 * AI-2479 — code-artifact disclosure record parsing/formatting.
 *
 * Covers the operand parser, the HTML-comment marker round-trip, and sha
 * comparison. The marker's interaction with issue-link rewriting is covered in
 * issues.test.ts ("does not rewrite identifiers inside an HTML comment") —
 * that is the case that silently corrupts a branch name.
 */

import {
  parseCodeArtifact,
  formatCodeArtifact,
  buildArtifactMarker,
  parseArtifactMarkers,
  sameArtifact,
  shasMatch,
} from "../artifact";

describe("parseCodeArtifact", () => {
  it("parses branch@sha", () => {
    expect(parseCodeArtifact("feature/AI-2479-guard@c81dfe0")).toEqual({
      branch: "feature/AI-2479-guard",
      sha: "c81dfe0",
    });
  });

  it("splits on the last @ so branch names containing @ survive", () => {
    expect(parseCodeArtifact("user@host/branch@abc1234")).toEqual({
      branch: "user@host/branch",
      sha: "abc1234",
    });
  });

  it("lowercases the sha", () => {
    expect(parseCodeArtifact("main@ABC1234").sha).toBe("abc1234");
  });

  it("accepts a full 40-char sha", () => {
    const sha = "a".repeat(40);
    expect(parseCodeArtifact(`main@${sha}`).sha).toBe(sha);
  });

  it.each([
    ["no @ at all", "feature/AI-2479"],
    ["empty branch", "@c81dfe0"],
    ["empty sha", "main@"],
    ["sha too short", "main@abc123"],
    ["sha too long", `main@${"a".repeat(41)}`],
    ["sha not hex", "main@zzzzzzz"],
    ["a tag rather than a sha", "main@v1.2.3"],
  ])("rejects %s", (_label, operand) => {
    expect(() => parseCodeArtifact(operand)).toThrow(/--code-artifact/);
  });
});

describe("marker round-trip", () => {
  it("builds a marker that parses back to the same artifact", () => {
    const a = { branch: "feature/AI-2479-guard", sha: "c81dfe0" };
    expect(parseArtifactMarkers(buildArtifactMarker(a))).toEqual([a]);
  });

  it("finds a marker embedded in surrounding prose", () => {
    const body = `Handing off for review.\n\n${buildArtifactMarker({ branch: "main", sha: "abc1234" })}\n`;
    expect(parseArtifactMarkers(body)).toEqual([{ branch: "main", sha: "abc1234" }]);
  });

  it("returns every marker in document order", () => {
    const body = [
      buildArtifactMarker({ branch: "first", sha: "1111111" }),
      "prose in between",
      buildArtifactMarker({ branch: "second", sha: "2222222" }),
    ].join("\n");
    expect(parseArtifactMarkers(body).map((a) => a.branch)).toEqual(["first", "second"]);
  });

  it("returns nothing for a body with no marker", () => {
    expect(parseArtifactMarkers("Just a normal handoff comment about AI-2479.")).toEqual([]);
  });

  it("skips a malformed marker rather than throwing", () => {
    // A single corrupt historical marker must not make a ticket ungateable.
    const body = `<!-- artifact-disclosure: {not json} -->\n${buildArtifactMarker({ branch: "ok", sha: "abc1234" })}`;
    expect(parseArtifactMarkers(body)).toEqual([{ branch: "ok", sha: "abc1234" }]);
  });

  it("skips a marker missing required fields", () => {
    expect(parseArtifactMarkers('<!-- artifact-disclosure: {"branch":"x"} -->')).toEqual([]);
  });

  it("does not emit the declaring agent into the marker", () => {
    // Identity is resolved from the OAuth token connector-side; a self-reported
    // author would be forgeable by the party being checked.
    const marker = buildArtifactMarker({ branch: "b", sha: "abc1234" });
    expect(marker).not.toMatch(/author|by|agent/i);
  });
});

describe("shasMatch", () => {
  it("matches a full sha against its abbreviation", () => {
    expect(shasMatch("c81dfe0", "c81dfe0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
  });

  it("is order-independent", () => {
    expect(shasMatch("c81dfe0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "c81dfe0")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(shasMatch("C81DFE0", "c81dfe0")).toBe(true);
  });

  it("does not match different commits", () => {
    expect(shasMatch("c81dfe0", "b777e17")).toBe(false);
  });

  it("does not match a mere substring that is not a prefix", () => {
    expect(shasMatch("81dfe0a", "c81dfe0a")).toBe(false);
  });
});

describe("sameArtifact", () => {
  const base = { branch: "feature/AI-2476", sha: "b777e17" };

  it("is true for identical artifacts", () => {
    expect(sameArtifact(base, { ...base })).toBe(true);
  });

  it("is true when one sha is an abbreviation of the other", () => {
    expect(sameArtifact(base, { branch: "feature/AI-2476", sha: "b777e17ffffffffffffffffffffffffffffffff" })).toBe(true);
  });

  it("is false when the sha differs — the AI-2476 incident shape", () => {
    // Validator reported its own commit on the same branch name.
    expect(sameArtifact(base, { branch: "feature/AI-2476", sha: "911ef85" })).toBe(false);
  });

  it("is false when the branch differs even at the same sha", () => {
    expect(sameArtifact(base, { branch: "feature/AI-2476-ai", sha: "b777e17" })).toBe(false);
  });
});

describe("formatCodeArtifact", () => {
  it("round-trips through parse", () => {
    const operand = "feature/AI-2479-guard@c81dfe0";
    expect(formatCodeArtifact(parseCodeArtifact(operand))).toBe(operand);
  });
});
