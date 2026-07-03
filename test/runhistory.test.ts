/** P1-4 RunRecord schema (headless): round-trip + malformed-line tolerance. */
import { describe, it, expect } from "vitest";
import { RunRecord, parseRunRecord, parseRunsFile, compareRuns } from "../runhistory";

const rec = {
  runId: "r1", threadId: "run", entry: "graphloupe_sidecar.graph:showcase_graph",
  input: { topic: "hi" }, startedAt: 1000, endedAt: 1800, status: "completed" as const,
  nodePath: ["ingest", "plan", "review", "gate", "synthesize"],
  branches: [{ source: "gate", key: "approve", target: "synthesize" }],
  tokens: { prompt: 180, completion: 34 }, error: null,
};

describe("RunRecord (P1-4)", () => {
  it("round-trips through serialize -> parse", () => {
    const restored = parseRunRecord(JSON.stringify(rec));
    expect(restored).toEqual(rec);
  });

  it("validates via zod (rejects a wrong-typed field)", () => {
    expect(() => RunRecord.parse({ ...rec, startedAt: "nope" })).toThrow();
  });

  it("parseRunRecord returns null on a malformed / empty line instead of throwing", () => {
    expect(parseRunRecord("{not json")).toBeNull();
    expect(parseRunRecord("   ")).toBeNull();
    expect(parseRunRecord(JSON.stringify({ runId: "x" }))).toBeNull();  // missing fields
  });

  it("parseRunsFile takes the most recent cap records newest-first, skipping bad lines", () => {
    const line = (id: string) => JSON.stringify({ ...rec, runId: id });
    const content = [line("a"), "garbage{", line("b"), "", line("c")].join("\n");
    const out = parseRunsFile(content, 2);
    expect(out.map((r) => r.runId)).toEqual(["c", "b"]);  // newest first, cap 2, "a" dropped, junk skipped
  });
});

describe("compareRuns (P1-5)", () => {
  const mk = (over: Partial<RunRecord>): RunRecord => ({ ...rec, ...over });

  it("finds the first divergence in the node path and the branch diff", () => {
    const a = mk({ nodePath: ["ingest", "plan", "review", "gate", "synthesize"], startedAt: 0, endedAt: 22200,
      tokens: { prompt: 12, completion: 4 }, branches: [{ source: "gate", key: "approve", target: "synthesize" }] });
    const b = mk({ nodePath: ["ingest", "plan", "review", "gate", "plan", "review", "gate", "synthesize"], startedAt: 0, endedAt: 5800,
      tokens: { prompt: 18, completion: 4 }, branches: [{ source: "gate", key: "redo", target: "plan" }, { source: "gate", key: "approve", target: "synthesize" }] });
    const c = compareRuns(a, b);
    expect(c.firstDivergenceIndex).toBe(4);   // gate then A→synthesize vs B→plan
    expect(c.pathIdentical).toBe(false);
    expect(c.tokensDelta).toBe(6);            // 22 − 16
    expect(c.durationDelta).toBe(-16400);     // 5800 − 22200
    expect(c.branchDiffs.map((d) => d.index)).toEqual([0, 1]);  // first router key differs; B has an extra decision
  });

  it("reports an identical path with null divergence but still deltas", () => {
    const a = mk({ nodePath: ["ingest", "plan"], tokens: { prompt: 10, completion: 0 }, input: { x: 1 } });
    const b = mk({ nodePath: ["ingest", "plan"], tokens: { prompt: 15, completion: 0 }, input: { x: 1 } });
    const c = compareRuns(a, b);
    expect(c.firstDivergenceIndex).toBeNull();
    expect(c.pathIdentical).toBe(true);
    expect(c.tokensDelta).toBe(5);
    expect(c.branchDiffs).toEqual([]);
    expect(c.inputChanged).toBe(false);
  });

  it("treats one path being a prefix of the other as divergence at the shorter length", () => {
    const c = compareRuns(mk({ nodePath: ["a", "b"] }), mk({ nodePath: ["a", "b", "c"] }));
    expect(c.firstDivergenceIndex).toBe(2);
    expect(c.pathIdentical).toBe(false);
  });

  it("flags status/input changes and a null duration delta when a run is unfinished", () => {
    const a = mk({ status: "completed", input: { q: "hi" }, endedAt: 2000, startedAt: 0 });
    const b = mk({ status: "aborted", input: { q: "bye" }, endedAt: null });
    const c = compareRuns(a, b);
    expect(c.statusChanged).toBe(true);
    expect(c.inputChanged).toBe(true);
    expect(c.durationDelta).toBeNull();
  });
});
