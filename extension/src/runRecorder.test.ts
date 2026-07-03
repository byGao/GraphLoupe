/** P1-4 RunRecorder (headless): accumulate a run from the command + event stream. */
import { describe, it, expect } from "vitest";
import { RunRecorder } from "./runRecorder";
import type { ClientCommand, ServerEvent } from "../../protocol";

const cmd = (c: unknown) => c as ClientCommand;
const ev = (e: unknown) => e as ServerEvent;
const ENTRY = "graphloupe_sidecar.graph:showcase_graph";

// deterministic clock: 1000, 1001, 1002, …
const clock = () => {
  let t = 1000;
  return () => t++;
};

describe("RunRecorder (P1-4)", () => {
  it("accumulates a completed run: path (collapsed), branches, tokens, input, timing", () => {
    const r = new RunRecorder(clock());
    r.onCommand(cmd({ type: "start_run", threadId: null, input: { topic: "hi" }, providerMode: "manual" }));
    expect(r.onEvent(ev({ type: "run_started", threadId: "run", runId: "r1", checkpointId: null }), ENTRY)).toBeNull();
    for (const node of ["ingest", "plan", "plan", "review", "gate", "synthesize"]) {  // dup plan -> collapsed
      r.onEvent(ev({ type: "node_start", threadId: "run", runId: "r1", node, checkpointId: "-", ts: 0 }), ENTRY);
    }
    r.onEvent(ev({ type: "branch_decisions", threadId: "run",
      decisions: [{ source: "gate", key: "approve", target: "synthesize", alternatives: {}, stateValues: {} }] }), ENTRY);
    r.onEvent(ev({ type: "llm_end", llmEventId: "a", tokens: { prompt: 100, completion: 20, source: "api_usage" }, finishReason: null }), ENTRY);
    r.onEvent(ev({ type: "llm_end", llmEventId: "b", tokens: { prompt: 80, completion: 14, source: "api_usage" }, finishReason: null }), ENTRY);

    const rec = r.onEvent(ev({ type: "run_finished", threadId: "run", runId: "r1", status: "completed", checkpointId: null }), ENTRY);
    expect(rec).not.toBeNull();
    expect(rec!.runId).toBe("r1-1000-0");  // minted unique id: <workerRunId>-<startedAt>-<seq>
    expect(rec!.entry).toBe(ENTRY);
    expect(rec!.input).toEqual({ topic: "hi" });
    expect(rec!.nodePath).toEqual(["ingest", "plan", "review", "gate", "synthesize"]);
    expect(rec!.branches).toEqual([{ source: "gate", key: "approve", target: "synthesize" }]);
    expect(rec!.tokens).toEqual({ prompt: 180, completion: 34 });
    expect(rec!.status).toBe("completed");
    expect(rec!.startedAt).toBeLessThan(rec!.endedAt!);
    expect(rec!.error).toBeNull();
  });

  it("captures aborted status with the partial path", () => {
    const r = new RunRecorder(clock());
    r.onEvent(ev({ type: "run_started", threadId: "run", runId: "r2", checkpointId: null }), ENTRY);
    r.onEvent(ev({ type: "node_start", threadId: "run", runId: "r2", node: "ingest", checkpointId: "-", ts: 0 }), ENTRY);
    r.onEvent(ev({ type: "node_start", threadId: "run", runId: "r2", node: "plan", checkpointId: "-", ts: 0 }), ENTRY);
    const rec = r.onEvent(ev({ type: "run_finished", threadId: "run", runId: "r2", status: "aborted", checkpointId: null }), ENTRY);
    expect(rec!.status).toBe("aborted");
    expect(rec!.nodePath).toEqual(["ingest", "plan"]);
  });

  it("records an error message", () => {
    const r = new RunRecorder(clock());
    r.onEvent(ev({ type: "run_started", threadId: "run", runId: "r3", checkpointId: null }), ENTRY);
    r.onEvent(ev({ type: "error", code: "graph_load_failed", message: "boom", detail: null, node: null, runId: "r3" }), ENTRY);
    const rec = r.onEvent(ev({ type: "run_finished", threadId: "run", runId: "r3", status: "error", checkpointId: null }), ENTRY);
    expect(rec!.status).toBe("error");
    expect(rec!.error).toBe("graph_load_failed: boom");
  });

  it("returns null on run_finished with no open run", () => {
    const r = new RunRecorder(clock());
    expect(r.onEvent(ev({ type: "run_finished", threadId: "run", runId: "x", status: "completed", checkpointId: null }), ENTRY)).toBeNull();
  });

  it("mints a DISTINCT runId per run even when the worker reuses the same runId/thread", () => {
    const r = new RunRecorder(clock());
    const finish = () => {
      r.onEvent(ev({ type: "run_started", threadId: "run", runId: "run", checkpointId: null }), ENTRY);
      return r.onEvent(ev({ type: "run_finished", threadId: "run", runId: "run", status: "completed", checkpointId: null }), ENTRY)!;
    };
    const a = finish(), b = finish();
    expect(a.runId).not.toBe(b.runId);  // both came from worker runId "run" but records differ
  });
});
