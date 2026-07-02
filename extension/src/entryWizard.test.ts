/** AC-01: entry-wizard adapter generation (P0-4). */
import { describe, it, expect } from "vitest";
import { renderAdapter, ADAPTER_ENTRY } from "./entryWizard";

describe("renderAdapter (R-02)", () => {
  it("imports the chosen module:symbol and exposes build_graph", () => {
    const src = renderAdapter("pipeline.graph", "app");
    expect(src).toContain("from pipeline.graph import app as _target");
    expect(src).toContain("def build_graph():");
  });

  it("tolerates both a factory (callable) and a compiled-graph variable", () => {
    const src = renderAdapter("pkg.mod", "make_graph");
    expect(src).toContain("_target() if callable(_target) else _target");
  });

  it("the written entry matches the adapter module:function", () => {
    expect(ADAPTER_ENTRY).toBe("entry:build_graph");
  });
});
