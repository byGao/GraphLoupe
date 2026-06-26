/** R-04 logic (headless): topology render + active-node highlight. */
import { describe, it, expect } from "vitest";
import { buildInput, defaultForm, formFields, initialState, needsGraphSelection, reduce, tokenSummary, type CanvasState } from "./model";
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
      pending: null, paused: null, snapshot: null, checkpoints: [], inputSchema: null,
      projectRoot: null, tokens: {}, llmPending: {},
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

  it("formFields filters array/object + flags paths; buildInput types + defaults", () => {
    const schema = {
      properties: {
        repo_path: { type: "string", title: "Repo Path" },
        count: { type: "integer" },
        worklist: { type: "array" },
        nodes: { type: "object" },
      },
    };
    const fields = formFields(schema);
    expect(fields.map((f) => f.name)).toEqual(["repo_path", "count"]);   // array/object hidden
    expect(fields.find((f) => f.name === "repo_path")?.isPath).toBe(true);
    expect(buildInput(schema, { repo_path: "/r", count: "3" }))
      .toEqual({ repo_path: "/r", count: 3, worklist: [], nodes: {} });  // typed + empty defaults
  });

  it("formFields surfaces schema title/description/default for the form", () => {
    const schema = { properties: {
      repo_path: { type: "string", title: "Repo Path", description: "Absolute path to the repo" },
      depth: { type: "integer", default: 1 },
    } };
    const fields = formFields(schema);
    const repo = fields.find((f) => f.name === "repo_path");
    expect(repo?.title).toBe("Repo Path");
    expect(repo?.description).toBe("Absolute path to the repo");
    expect(fields.find((f) => f.name === "depth")?.placeholder).toBe("1");  // default as placeholder
  });

  it("defaultForm pre-fills paths from project root and target from its basename", () => {
    const fields = formFields({ properties: {
      repo_path: { type: "string" }, out_dir: { type: "string" },
      target: { type: "string" }, count: { type: "integer" },
    } });
    const vals = defaultForm(fields, "C:/work/WikiGraph/");
    expect(vals.repo_path).toBe("C:/work/WikiGraph");      // root, trailing slash trimmed
    expect(vals.out_dir).toBe("C:/work/WikiGraph/out");    // out-ish path -> root/out
    expect(vals.target).toBe("WikiGraph");                 // basename, non-path string
    expect(vals.count).toBeUndefined();                    // non-path scalar left blank
    expect(defaultForm(fields, null)).toEqual({});         // no root -> nothing to seed
  });

  it("graph event carries projectRoot into state", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["a"], edges: [], projectRoot: "/r" }));
    expect(s.projectRoot).toBe("/r");
  });

  it("token economy: aggregates per-node prompt/completion, totals, heaviest; run_started resets", () => {
    const lstart = (node: string, id: string, prompt: number, source = "sidecar_estimate") =>
      ev({ type: "llm_start", threadId: "t", runId: "t", node, llmEventId: id, model: "m",
        promptTokens: { prompt, completion: null, source } });
    const lend = (id: string, completion: number, source = "sidecar_estimate", prompt = 0) =>
      ev({ type: "llm_end", llmEventId: id, tokens: { prompt, completion, source }, finishReason: null });

    let s = reduce(initialState, ev({ type: "run_started" }));
    s = reduce(s, lstart("llm", "a", 100));
    s = reduce(s, lend("a", 12));                          // estimate end -> keep start's prompt
    s = reduce(s, lstart("critic", "b", 30));
    s = reduce(s, lend("b", 5));
    s = reduce(s, lstart("llm", "c", 50));                 // llm called twice
    s = reduce(s, lend("c", 8));

    const sum = tokenSummary(s);
    expect(sum.rows.map((r) => r.node)).toEqual(["llm", "critic"]);   // sorted by total desc
    expect(sum.rows[0]).toMatchObject({ node: "llm", calls: 2, prompt: 150, completion: 20, estimated: true });
    expect(sum.total).toEqual({ calls: 3, prompt: 180, completion: 25 });
    expect(sum.heaviest).toBe("llm");
    expect(sum.estimated).toBe(true);

    s = reduce(s, ev({ type: "run_started" }));            // next run clears the tally
    expect(tokenSummary(s).rows).toEqual([]);
  });

  it("token economy: api_usage end overrides the start estimate and is not flagged estimated", () => {
    let s = reduce(initialState, ev({ type: "run_started" }));
    s = reduce(s, ev({ type: "llm_start", threadId: "t", runId: "t", node: "llm", llmEventId: "a",
      model: "gpt", promptTokens: { prompt: 99, completion: null, source: "sidecar_estimate" } }));
    s = reduce(s, ev({ type: "llm_end", llmEventId: "a",
      tokens: { prompt: 120, completion: 40, source: "api_usage" }, finishReason: "stop" }));
    const row = tokenSummary(s).rows[0];
    expect(row).toMatchObject({ node: "llm", prompt: 120, completion: 40, estimated: false });  // exact wins
  });

  it("token economy: llm_end without a matching start is ignored", () => {
    const s = reduce({ ...initialState, running: true },
      ev({ type: "llm_end", llmEventId: "ghost", tokens: { prompt: 0, completion: 9, source: "sidecar_estimate" }, finishReason: null }));
    expect(tokenSummary(s).rows).toEqual([]);
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
