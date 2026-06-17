/** R-04 logic (headless): topology render + active-node highlight. */
import { describe, it, expect } from "vitest";
import { initialState, reduce, type CanvasState } from "./model";
import type { ServerEvent } from "../../protocol";

const ev = (e: unknown) => e as ServerEvent;

describe("canvas reducer", () => {
  it("graph event sets nodes and edges", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["__start__", "prepare", "llm"], edges: [["__start__", "prepare"], ["prepare", "llm"]] }));
    expect(s.nodes).toEqual(["__start__", "prepare", "llm"]);
    expect(s.edges).toEqual([["__start__", "prepare"], ["prepare", "llm"]]);
  });

  it("node_start highlights, node_end clears", () => {
    let s: CanvasState = { nodes: ["llm"], edges: [], active: null, running: true };
    s = reduce(s, ev({ type: "node_start", node: "llm" }));
    expect(s.active).toBe("llm");
    s = reduce(s, ev({ type: "node_end", node: "llm" }));
    expect(s.active).toBeNull();
  });

  it("run_started sets running, run_finished clears running + active", () => {
    let s = reduce(initialState, ev({ type: "run_started" }));
    expect(s.running).toBe(true);
    s = reduce({ ...s, active: "llm" }, ev({ type: "run_finished" }));
    expect(s.running).toBe(false);
    expect(s.active).toBeNull();
  });
});
