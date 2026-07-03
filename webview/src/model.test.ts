/** R-04 logic (headless): topology render + active-node highlight. */
import { describe, it, expect } from "vitest";
import { autoTab, branchRows, buildInput, defaultForm, formatDiffEntry, formFields, healthChecks, initialState, needsGraphSelection, nodeKind, overviewRows, reduce, runSummary, sourceLabel, splitCurrentRun, toggleCompare, tokenSummary, topoOrder, type CanvasState, type RunRecord } from "./model";
import type { ServerEvent } from "../../protocol";

const ev = (e: unknown) => e as ServerEvent;

describe("run history (P1-4)", () => {
  const mk = (over: Partial<RunRecord>): RunRecord => ({
    runId: "r", threadId: "run", entry: "m:g", input: {}, startedAt: 1000, endedAt: 2800,
    status: "completed", nodePath: ["ingest", "plan"], branches: [], tokens: { prompt: 10, completion: 4 }, error: null, ...over,
  });

  it("runSummary joins the path, sums tokens, computes duration", () => {
    const s = runSummary(mk({ nodePath: ["a", "b", "c"], tokens: { prompt: 100, completion: 20 } }));
    expect(s.path).toBe("a → b → c");
    expect(s.tokens).toBe(120);
    expect(s.durationMs).toBe(1800);
  });

  it("runSummary handles an empty path and an unfinished run", () => {
    const s = runSummary(mk({ nodePath: [], endedAt: null }));
    expect(s.path).toBe("(no nodes)");
    expect(s.durationMs).toBeNull();
  });

  it("toggleCompare adds, removes, and caps the selection at 2 (drops oldest)", () => {
    expect(toggleCompare([], "a")).toEqual(["a"]);
    expect(toggleCompare(["a"], "a")).toEqual([]);            // re-toggle removes
    expect(toggleCompare(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleCompare(["a", "b"], "c")).toEqual(["b", "c"]);  // cap 2, oldest "a" dropped
  });
});

describe("splitCurrentRun (P1-2 time-travel readability)", () => {
  const cp = (node: string | null, id: string) => ({ node, checkpointId: id });

  it("keeps the current run (head down to its __start__) and collapses older runs", () => {
    // two runs stacked newest-first: [review, plan, __start__ | end, gate, __start__]
    const list = [cp("review", "a"), cp("plan", "b"), cp("__start__", "c"),
                  cp(null, "d"), cp("gate", "e"), cp("__start__", "f")];
    const { current, older } = splitCurrentRun(list);
    expect(current.map((c) => c.node)).toEqual(["review", "plan", "__start__"]);
    expect(older.map((c) => c.node)).toEqual([null, "gate", "__start__"]);
  });

  it("returns everything as current when there is no __start__ boundary", () => {
    const list = [cp("review", "a"), cp("plan", "b")];
    const { current, older } = splitCurrentRun(list);
    expect(current).toHaveLength(2);
    expect(older).toHaveLength(0);
  });
});

describe("state timeline (P1-2)", () => {
  const steps = [
    { seq: 0, checkpointId: "a", node: "ingest", diff: [{ channel: "query", op: "add", before: null, after: "hi" }] },
    { seq: 1, checkpointId: "b", node: "plan", diff: [{ channel: "steps", op: "update", before: 2, after: 3 }] },
  ];

  it("reduce stores the timeline and clears it on run_started / graph", () => {
    const s = reduce(initialState, ev({ v: "0.1.0", corr: null, type: "state_timeline", threadId: "t", steps }));
    expect(s.timeline).toHaveLength(2);
    expect(reduce(s, ev({ v: "0.1.0", corr: null, type: "run_started", threadId: "t", runId: "t", checkpointId: null })).timeline).toEqual([]);
    expect(reduce(s, ev({ v: "0.1.0", corr: null, type: "graph", nodes: ["ingest"], edges: [] })).timeline).toEqual([]);
  });

  it("formatDiffEntry renders update / add / remove readably", () => {
    expect(formatDiffEntry({ channel: "steps", op: "update", before: 2, after: 3 })).toBe("~ steps: 2 → 3");
    expect(formatDiffEntry({ channel: "notes", op: "add", before: null, after: "outline" })).toBe("+ notes: outline");
    expect(formatDiffEntry({ channel: "tmp", op: "remove", before: "gone", after: null })).toBe("− tmp: gone");
  });

  it("formatDiffEntry truncates long strings and summarizes list/dict", () => {
    const long = "x".repeat(80);
    const line = formatDiffEntry({ channel: "c", op: "add", before: null, after: long });
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(60);
    expect(formatDiffEntry({ channel: "msgs", op: "update", before: [1], after: [1, 2, 3] })).toBe("~ msgs: list[1] → list[3]");
    expect(formatDiffEntry({ channel: "obj", op: "add", before: null, after: { a: 1, b: 2 } })).toBe("+ obj: {2 keys}");
  });
});

describe("branch decisions (P1-3)", () => {
  const decisions = [{
    source: "gate", key: "approve", target: "synth",
    alternatives: { approve: "synth", redo: "plan", abort: "__end__" }, stateValues: { steps: 3 },
  }];

  it("reduce stores decisions and clears them on run_started / graph", () => {
    const s = reduce(initialState, ev({ v: "0.1.0", corr: null, type: "branch_decisions", threadId: "t", decisions }));
    expect(s.branchDecisions).toHaveLength(1);
    expect(reduce(s, ev({ v: "0.1.0", corr: null, type: "run_started", threadId: "t", runId: "t", checkpointId: null })).branchDecisions).toEqual([]);
    expect(reduce(s, ev({ v: "0.1.0", corr: null, type: "graph", nodes: ["gate"], edges: [] })).branchDecisions).toEqual([]);
  });

  it("branchRows lists the taken key and the paths NOT taken", () => {
    const [row] = branchRows({ ...initialState, branchDecisions: decisions });
    expect(row).toMatchObject({ source: "gate", target: "synth", key: "approve" });
    expect(row.notTaken).toEqual([{ key: "redo", target: "plan" }, { key: "abort", target: "__end__" }]);
  });

  it("no decisions -> empty rows", () => {
    expect(branchRows(initialState)).toEqual([]);
  });
});

describe("healthChecks (P0-5)", () => {
  const base = (over: Partial<CanvasState>): CanvasState => ({ ...initialState, ...over });
  const by = (checks: ReturnType<typeof healthChecks>, label: string) => checks.find((c) => c.label === label);

  it("checkpointer present -> ok; absent -> warn", () => {
    const ok = healthChecks(base({ nodes: ["a"], hasCheckpointer: true }));
    expect(by(ok, "Checkpointer")?.status).toBe("ok");
    const warn = healthChecks(base({ nodes: ["a"], hasCheckpointer: false }));
    expect(by(warn, "Checkpointer")?.status).toBe("warn");
  });

  it("no input schema -> info; llm nodes counted", () => {
    const checks = healthChecks(base({ nodes: ["a", "b"], inputSchema: null, nodeKinds: { a: "llm", b: "manual" } }));
    expect(by(checks, "Run input schema")?.status).toBe("info");
    expect(by(checks, "LLM / inference nodes")?.detail).toContain("2");
  });

  it("schema without field descriptions -> warn", () => {
    const checks = healthChecks(base({ nodes: ["a"], inputSchema: { properties: { repo: { type: "string" } } } }));
    expect(by(checks, "Run input schema")?.status).toBe("warn");
  });

  it("graph_load_failed -> a single error check, nothing false-ok", () => {
    const checks = healthChecks(base({ error: "graph_load_failed: ImportError: no langchain" }));
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("error");
    expect(checks.every((c) => c.status !== "ok")).toBe(true);
  });
});

describe("node source (P1-1)", () => {
  it("graph event stores nodeSources; absent defaults to empty", () => {
    const withSrc = reduce(initialState, ev({ type: "graph", nodes: ["n"], edges: [],
      nodeSources: { n: { file: "/p/graph.py", line: 7 } } }));
    expect(withSrc.nodeSources.n).toEqual({ file: "/p/graph.py", line: 7 });
    const without = reduce(initialState, ev({ type: "graph", nodes: ["n"], edges: [] }));
    expect(without.nodeSources).toEqual({});
  });

  it("sourceLabel shows basename:line for posix and windows paths", () => {
    expect(sourceLabel({ file: "/work/demo/graph.py", line: 42 })).toBe("graph.py:42");
    expect(sourceLabel({ file: "C:\\proj\\pipeline\\flow.py", line: 3 })).toBe("flow.py:3");
  });
});

describe("canvas reducer", () => {
  it("graph event sets nodes and edges", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["__start__", "prepare", "llm"], edges: [["__start__", "prepare"], ["prepare", "llm"]] }));
    expect(s.nodes).toEqual(["__start__", "prepare", "llm"]);
    expect(s.edges).toEqual([["__start__", "prepare"], ["prepare", "llm"]]);
  });

  it("node_start highlights, node_end clears", () => {
    // spread initialState so new CanvasState fields don't have to be repeated here
    let s: CanvasState = { ...initialState, nodes: ["llm"], running: true };
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

  it("breakpoint_hit -> paused; state_snapshot -> snapshot; run_finished clears", () => {
    let s = reduce(initialState, ev({ type: "breakpoint_hit", node: "b", when: "before", checkpointId: "c1" }));
    expect(s.paused).toEqual({ node: "b", checkpointId: "c1" });
    s = reduce(s, ev({ type: "state_snapshot", snapshot: { values: { log: ["a"] }, diff: [{ channel: "log", op: "add", before: null, after: ["a"] }] } }));
    expect(s.snapshot?.values).toEqual({ log: ["a"] });
    s = reduce(s, ev({ type: "run_finished", status: "completed" }));
    expect(s.paused).toBeNull();
    expect(s.snapshot).toBeNull();
  });

  it("checkpoint_history populates the time-travel timeline; run_started clears it", () => {
    const hist = ev({ type: "checkpoint_history", threadId: "run", checkpoints: [
      { checkpointId: "c2", node: "review" },
      { checkpointId: "c1", node: "plan" },
      { checkpointId: "c0", node: "ingest" },
    ] });
    let s = reduce(initialState, hist);
    expect(s.checkpoints.map((c) => c.node)).toEqual(["review", "plan", "ingest"]);
    s = reduce(s, ev({ type: "run_started" }));
    expect(s.checkpoints).toEqual([]);
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

  it("token economy: carries the last call's prompt/response text per node", () => {
    let s = reduce(initialState, ev({ type: "run_started" }));
    s = reduce(s, ev({ type: "llm_start", threadId: "t", runId: "t", node: "plan", llmEventId: "a",
      model: "m", promptTokens: { prompt: 10, completion: null, source: "sidecar_estimate" }, promptText: "Analyze repo" }));
    s = reduce(s, ev({ type: "llm_end", llmEventId: "a",
      tokens: { prompt: 0, completion: 5, source: "sidecar_estimate" }, finishReason: null, completionText: "Plan: scan" }));
    const row = tokenSummary(s).rows[0];
    expect(row.lastPrompt).toBe("Analyze repo");
    expect(row.lastResponse).toBe("Plan: scan");
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

  it("graph event stores nodeDocs and resets learned kinds", () => {
    let s = reduce(initialState, ev({ type: "llm_start", threadId: "t", runId: "t", node: "old",
      llmEventId: "x", model: "m", promptTokens: { prompt: 1, completion: null, source: "sidecar_estimate" } }));
    expect(nodeKind(s, "old")).toBe("llm");
    s = reduce(s, ev({ type: "graph", nodes: ["a", "b"], edges: [["a", "b"]],
      nodeDocs: { a: "do A", b: null } }));
    expect(s.nodeDocs).toEqual({ a: "do A", b: null });
    expect(nodeKind(s, "old")).toBe("script");  // kinds reset on new graph
  });

  it("graph event seeds lane kinds from the worker's static nodeKinds (visible pre-run)", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["prepare", "llm"], edges: [["prepare", "llm"]],
      nodeKinds: { prepare: "script", llm: "llm" } }));
    expect(nodeKind(s, "llm")).toBe("llm");      // classified before any run
    expect(nodeKind(s, "prepare")).toBe("script");
  });

  it("graph event stores edge branch labels", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["gate", "review", "plan"],
      edges: [["gate", "review"], ["gate", "plan"]],
      edgeLabels: { "gate->review": "human", "gate->plan": "redo" } }));
    expect(s.edgeLabels["gate->review"]).toBe("human");
    expect(s.edgeLabels["gate->plan"]).toBe("redo");
  });

  it("node kind: llm_start -> llm, manual interrupt -> manual; persists across runs", () => {
    let s = reduce(initialState, ev({ type: "graph", nodes: ["scan", "summarize", "ask"], edges: [] }));
    expect(nodeKind(s, "summarize")).toBe("script");
    s = reduce(s, ev({ type: "llm_start", threadId: "t", runId: "t", node: "summarize",
      llmEventId: "a", model: "m", promptTokens: { prompt: 5, completion: null, source: "sidecar_estimate" } }));
    s = reduce(s, ev({ type: "manual_inference_required", node: "ask", threadId: "t", interruptId: "i",
      renderedText: "?", expects: "text", promptTokens: { prompt: 1, completion: null, source: "sidecar_estimate" }, toolSchema: null, messages: [] }));
    expect(nodeKind(s, "summarize")).toBe("llm");
    expect(nodeKind(s, "ask")).toBe("manual");      // interrupt -> manual, distinct from llm
    s = reduce(s, ev({ type: "run_started" }));     // a new run must NOT forget learned kinds
    expect(nodeKind(s, "summarize")).toBe("llm");
    expect(nodeKind(s, "ask")).toBe("manual");
    expect(nodeKind(s, "scan")).toBe("script");
  });

  it("graph event seeds manual kind from the worker's static nodeKinds", () => {
    const s = reduce(initialState, ev({ type: "graph", nodes: ["plan", "review", "gate"], edges: [],
      nodeKinds: { plan: "llm", review: "manual", gate: "script" } }));
    expect(nodeKind(s, "plan")).toBe("llm");
    expect(nodeKind(s, "review")).toBe("manual");   // visible pre-run
    expect(nodeKind(s, "gate")).toBe("script");
  });

  it("topoOrder is BFS from __start__; overviewRows drops synthetics and carries kind+doc", () => {
    const nodes = ["__start__", "a", "b", "__end__"];
    const edges: [string, string][] = [["__start__", "a"], ["a", "b"], ["b", "__end__"]];
    expect(topoOrder(nodes, edges)).toEqual(["__start__", "a", "b", "__end__"]);
    let s = reduce(initialState, ev({ type: "graph", nodes, edges, nodeDocs: { a: "do A", b: "do B" } }));
    s = reduce(s, ev({ type: "llm_start", threadId: "t", runId: "t", node: "b",
      llmEventId: "z", model: "m", promptTokens: { prompt: 1, completion: null, source: "sidecar_estimate" } }));
    expect(overviewRows(s)).toEqual([
      { node: "a", kind: "script", doc: "do A" },
      { node: "b", kind: "llm", doc: "do B" },
    ]);
  });

  it("autoTab: manual pause -> manual, breakpoint pause -> state, else keep current", () => {
    expect(autoTab({ ...initialState, pending: { node: "ask" } as never }, "run")).toBe("manual");
    expect(autoTab({ ...initialState, paused: { node: "b", checkpointId: "c" } }, "tokens")).toBe("state");
    expect(autoTab(initialState, "tokens")).toBe("tokens");        // nothing pending -> stay
    // a manual pause wins over a breakpoint
    expect(autoTab({ ...initialState, pending: { node: "ask" } as never, paused: { node: "b", checkpointId: "c" } }, "run")).toBe("manual");
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
