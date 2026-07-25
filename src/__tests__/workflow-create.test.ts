import {
  normalizeWorkflowId,
  buildWorkflowRequestMarker,
  appendWorkflowRequestMarker,
  WF_PENDING_LABEL,
} from "../workflow-create";

describe("INF-552 normalizeWorkflowId (thin, taxonomy-free normalizer)", () => {
  it("normalizes a bare id to the verbatim workflow id", () => {
    expect(normalizeWorkflowId("dev-impl")).toBe("dev-impl");
  });

  it("accepts the label form and strips the wf: prefix", () => {
    expect(normalizeWorkflowId("wf:dev-impl")).toBe("dev-impl");
  });

  it("strips the wf: prefix case-insensitively", () => {
    expect(normalizeWorkflowId("WF:dev-impl")).toBe("dev-impl");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeWorkflowId("  dev-impl  ")).toBe("dev-impl");
  });

  it("preserves the id verbatim — no allowlist, no lowercasing (engine validates)", () => {
    // The engine is the sole registry holder; the CLI must not transform or
    // gate the id. The connector decides whether it resolves (bootstrap) or is
    // rejected loudly.
    expect(normalizeWorkflowId("sprint-spawner")).toBe("sprint-spawner");
    expect(normalizeWorkflowId("some-third-party-flow")).toBe("some-third-party-flow");
    expect(normalizeWorkflowId("Dev-Impl")).toBe("Dev-Impl");
    // Even an id the registry will reject still normalizes — rejection is the
    // engine's job (loud bounce to requester), not the CLI's.
    expect(normalizeWorkflowId("dev-imple")).toBe("dev-imple");
  });

  it("throws only on a structurally-empty value", () => {
    expect(() => normalizeWorkflowId("")).toThrow("requires a workflow id");
    expect(() => normalizeWorkflowId("   ")).toThrow("requires a workflow id");
    expect(() => normalizeWorkflowId("wf:")).toThrow("requires a workflow id");
  });
});

describe("INF-552 workflow-request marker (CLI → engine channel)", () => {
  it("attaches the fixed, taxonomy-free sentinel label", () => {
    expect(WF_PENDING_LABEL).toBe("wf:pending");
  });

  it("builds an invisible HTML-comment marker carrying the verbatim id", () => {
    expect(buildWorkflowRequestMarker("dev-impl")).toBe(
      '<!-- openclaw:workflow-request id="dev-impl" -->'
    );
    // Verbatim — the engine matches the registry exactly.
    expect(buildWorkflowRequestMarker("Some-Third-Party")).toBe(
      '<!-- openclaw:workflow-request id="Some-Third-Party" -->'
    );
  });

  it("appends the marker below an existing body, separated by a blank line", () => {
    const out = appendWorkflowRequestMarker("Fix the thing.", "dev-impl");
    expect(out).toBe('Fix the thing.\n\n<!-- openclaw:workflow-request id="dev-impl" -->');
  });

  it("stands the marker alone when there is no description", () => {
    expect(appendWorkflowRequestMarker(undefined, "dev-impl")).toBe(
      '<!-- openclaw:workflow-request id="dev-impl" -->'
    );
    expect(appendWorkflowRequestMarker("   ", "dev-impl")).toBe(
      '<!-- openclaw:workflow-request id="dev-impl" -->'
    );
  });
});
