/** P1-4 RunRecord schema (headless): round-trip + malformed-line tolerance. */
import { describe, it, expect } from "vitest";
import { RunRecord, parseRunRecord, parseRunsFile } from "../runhistory";

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
