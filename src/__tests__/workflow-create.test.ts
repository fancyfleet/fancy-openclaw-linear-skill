import { resolveWorkflowLabelName } from "../workflow-create";

describe("INF-552 resolveWorkflowLabelName (thin, taxonomy-free normalizer)", () => {
  it("normalizes a bare id to the wf:<id> label name", () => {
    expect(resolveWorkflowLabelName("dev-impl")).toBe("wf:dev-impl");
  });

  it("accepts the label form and returns it normalized", () => {
    expect(resolveWorkflowLabelName("wf:dev-impl")).toBe("wf:dev-impl");
  });

  it("strips the wf: prefix case-insensitively", () => {
    expect(resolveWorkflowLabelName("WF:dev-impl")).toBe("wf:dev-impl");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveWorkflowLabelName("  dev-impl  ")).toBe("wf:dev-impl");
  });

  it("preserves the id verbatim — no allowlist, no lowercasing (engine validates)", () => {
    // The engine is the sole registry holder; the CLI must not transform or
    // gate the id. Any id normalizes to a label; the connector decides whether
    // it resolves (bootstrap) or is rejected loudly.
    expect(resolveWorkflowLabelName("sprint-spawner")).toBe("wf:sprint-spawner");
    expect(resolveWorkflowLabelName("some-third-party-flow")).toBe("wf:some-third-party-flow");
    expect(resolveWorkflowLabelName("Dev-Impl")).toBe("wf:Dev-Impl");
    // Even an id the registry will reject still normalizes — rejection is the
    // engine's job (loud bounce to requester), not the CLI's.
    expect(resolveWorkflowLabelName("dev-imple")).toBe("wf:dev-imple");
  });

  it("throws only on a structurally-empty value (cannot form a label)", () => {
    expect(() => resolveWorkflowLabelName("")).toThrow("requires a workflow id");
    expect(() => resolveWorkflowLabelName("   ")).toThrow("requires a workflow id");
    expect(() => resolveWorkflowLabelName("wf:")).toThrow("requires a workflow id");
  });
});
