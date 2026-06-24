/** R-04 logic (headless): topology render + active-node highlight. */
import { describe, it, expect } from "vitest";
import { initialState, needsGraphSelection, reduce, type CanvasState } from "./model";
import type { ServerEvent } from "../../protocol";

const ev = (e: unknown) => e as ServerEvent;

describe("canvas reducer", () => {
  it("graph event sets nodes and edges", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["__start__", "prepare", "llm"], edges: [["__start__", "prepare"], ["prepare", "llm"]] }));
    expect(s.nodes).toEqual(["__start__", "prepare", "llm"]);
    expect(s.edges).toEqual([["__start__", "prepare"], ["prepare", "llm"]]);
  });

  it("node_start highlights, node_end clears", () => {
    let s: CanvasState = {
      nodes: ["llm"], edges: [], active: null, running: true, error: null,
      pending: null, paused: null, snapshot: null, checkpoints: [],
    };
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

  it("error (graph_load_failed) sets error and stops running", () => {
    const s = reduce({ ...initialState, running: true }, ev({ type: "error", code: "graph_load_failed", message: "no module" }));
    expect(s.error).toBe("graph_load_failed: no module");
    expect(s.running).toBe(false);
  });

  it("manual_inference_required sets pending; node_start/run_finished clear it", () => {
    const req = ev({
      type: "manual_inference_required", node: "ask", threadId: "run", interruptId: "i1",
      renderedText: "ask?", expects: "text", promptTokens: { prompt: 5, completion: null, source: "sidecar_estimate" },
      toolSchema: null, messages: [],
    });
    let s = reduce(initialState, req);
    expect(s.pending?.interruptId).toBe("i1");
    expect(s.pending?.expects).toBe("text");
    s = reduce(s, ev({ type: "node_start", node: "ask" }));  // resume re-run clears it
    expect(s.pending).toBeNull();
  });

  it("breakpoint_hit -> paused + checkpoint; state_snapshot -> snapshot; run_finished clears", () => {
    let s = reduce(initialState, ev({ type: "breakpoint_hit", node: "b", when: "before", checkpointId: "c1" }));
    expect(s.paused).toEqual({ node: "b", checkpointId: "c1" });
    expect(s.checkpoints).toEqual(["c1"]);
    s = reduce(s, ev({ type: "state_snapshot", snapshot: { values: { log: ["a"] }, diff: [{ channel: "log", op: "add", before: null, after: ["a"] }] } }));
    expect(s.snapshot?.values).toEqual({ log: ["a"] });
    s = reduce(s, ev({ type: "run_finished", status: "completed" }));
    expect(s.paused).toBeNull();
    expect(s.snapshot).toBeNull();
  });

  it("needsGraphSelection: true with no graph, false once a graph loads", () => {
    expect(needsGraphSelection(initialState)).toBe(true);
    const loaded = reduce(initialState, ev({ type: "graph", nodes: ["a"], edges: [] }));
    expect(needsGraphSelection(loaded)).toBe(false);
    // graph_load_failed arrives with no graph (empty nodes) -> CTA shows
    const loadFailed = reduce(initialState, ev({ type: "error", code: "graph_load_failed", message: "x" }));
    expect(needsGraphSelection(loadFailed)).toBe(true);
    // a run-time error while a graph is on screen -> keep graph, no CTA (banner only)
    const runErr = reduce(loaded, ev({ type: "error", code: "internal", message: "boom" }));
    expect(needsGraphSelection(runErr)).toBe(false);
    expect(runErr.error).toBe("internal: boom");
  });
});
