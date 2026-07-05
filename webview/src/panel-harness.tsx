/**
 * Panel render harness (self-review): mounts the inspector panels with mock data so a
 * headless screenshot can be reviewed against the spec's FIG.1 before F5 — the VS Code
 * webview itself can't be driven headlessly. Built by tools/render-panels.mjs. Not shipped.
 */
import { createRoot } from "react-dom/client";
import { ComparePanel, HistoryPanel, BranchPanel } from "./App";
import type { RunRecord } from "../../runhistory";
import "./styles.css";  // the webview's CSS custom properties (--surface-2, --pause, …)

const rec = (over: Partial<RunRecord>): RunRecord => ({
  runId: "r", threadId: "run", entry: "graphloupe_sidecar.graph:showcase_graph", input: { topic: "hi" },
  startedAt: Date.parse("2026-07-05T10:20:55"), endedAt: Date.parse("2026-07-05T10:21:05"),
  status: "completed", nodePath: ["ingest", "plan", "review", "gate", "synthesize"],
  branches: [{ source: "gate", key: "approve", target: "synthesize" }],
  tokens: { prompt: 20, completion: 2 }, error: null, finalState: { steps: 3, query: "hi" }, ...over,
});

// A = looped run (8 nodes, redo then approve, more tokens, extra summary channel)
const A = rec({
  runId: "a", startedAt: Date.parse("2026-07-05T10:20:55"), endedAt: Date.parse("2026-07-05T10:21:05"),
  nodePath: ["ingest", "plan", "review", "gate", "plan", "review", "gate", "synthesize"],
  branches: [{ source: "gate", key: "redo", target: "plan" }, { source: "gate", key: "approve", target: "synthesize" }],
  tokens: { prompt: 28, completion: 2 }, finalState: { steps: 5, query: "hi", summary: "Revised plan: 1. scan 2. cluster 3. critique 4. summarize" },
});
// B = direct run (5 nodes, approve straight away)
const B = rec({ runId: "b", startedAt: Date.parse("2026-07-05T10:20:46"), endedAt: Date.parse("2026-07-05T10:20:52") });

const runs: RunRecord[] = [A, B, rec({ runId: "c", status: "aborted", nodePath: ["ingest", "plan"], branches: [], tokens: { prompt: 8, completion: 0 } })];

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ width: 330, border: "1px solid #21262d", borderRadius: 8, background: "#0d1117", overflow: "hidden" }}>
    <div style={{ padding: "6px 12px", color: "#6e7681", fontSize: 11, borderBottom: "1px solid #21262d", background: "#0b0f14" }}>{title}</div>
    {children}
  </div>
);

function Harness() {
  return (
    <div style={{ display: "flex", gap: 20, padding: 20, flexWrap: "wrap", alignItems: "flex-start",
      background: "#010409", color: "#c9d1d9", fontFamily: "monospace", minHeight: "100vh" }}>
      <Box title="ComparePanel — A(loop) vs B(direct): state diff expected"><ComparePanel a={A} b={B} /></Box>
      <Box title="ComparePanel — identical final state"><ComparePanel a={B} b={rec({ runId: "b2" })} /></Box>
      <Box title="HistoryPanel — 3 runs"><HistoryPanel runs={runs} /></Box>
      <Box title="BranchPanel"><BranchPanel rows={[{ source: "gate", target: "synthesize", key: "approve", notTaken: [{ key: "redo", target: "plan" }, { key: "abort", target: "__end__" }] }]} hasCheckpointer={true} /></Box>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
