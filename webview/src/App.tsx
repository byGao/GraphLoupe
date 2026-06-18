import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { initialState, reduce, type CanvasState } from "./model";
import type { ServerEvent } from "../../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

/** Layered left-to-right layout by BFS depth from __start__ (so start -> ... -> end, no crossings). */
function layout(nodes: string[], edges: [string, string][]): Record<string, { x: number; y: number }> {
  const adj: Record<string, string[]> = {};
  nodes.forEach((n) => (adj[n] = []));
  edges.forEach(([s, t]) => adj[s]?.push(t));
  const depth: Record<string, number> = {};
  const start = nodes.includes("__start__") ? "__start__" : nodes[0];
  const queue: string[] = start ? [start] : [];
  if (start) depth[start] = 0;
  while (queue.length) {
    const n = queue.shift() as string;
    for (const m of adj[n] ?? []) {
      if (depth[m] === undefined) {
        depth[m] = depth[n] + 1;
        queue.push(m);
      }
    }
  }
  let maxDepth = Math.max(0, ...Object.values(depth));
  nodes.forEach((n) => {
    if (depth[n] === undefined) depth[n] = ++maxDepth;
  });
  const perDepth: Record<number, number> = {};
  const pos: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n) => {
    const d = depth[n];
    const row = perDepth[d] ?? 0;
    perDepth[d] = row + 1;
    pos[n] = { x: d * 210, y: 70 + row * 110 };
  });
  return pos;
}

const startRun = {
  v: "0.1.0", corr: null, type: "start_run",
  threadId: null, input: { messages: [], steps: 0 }, providerMode: "manual",
};

export default function App() {
  const [state, setState] = useState<CanvasState>(initialState);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const ev = e.data as ServerEvent;
      if (ev && typeof ev.type === "string") setState((s) => reduce(s, ev));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const nodes: Node[] = useMemo(() => {
    const pos = layout(state.nodes, state.edges);
    return state.nodes.map((id) => ({
      id,
      position: pos[id],
      data: { label: id },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style:
        id === state.active
          ? { border: "2px solid #3fb950", background: "#10301a", color: "#56d364" }
          : undefined,
    }));
  }, [state.nodes, state.edges, state.active]);

  const edges: Edge[] = useMemo(
    () => state.edges.map(([s, t], i) => ({ id: `e${i}`, source: s, target: t })),
    [state.edges],
  );

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #30363d" }}>
        <button disabled={state.running} onClick={() => vscode.postMessage(startRun)}>
          ▶ Run
        </button>
        <span style={{ marginLeft: 12, color: "#8b949e" }}>
          execution view (read-only){state.running ? " · running" : ""}
        </span>
      </div>
      {state.error && (
        <div style={{ padding: "8px 12px", background: "#3d1518", borderBottom: "1px solid #6b2020", color: "#ff7b72", fontSize: 13 }}>
          ⚠ graph load failed — {state.error}
        </div>
      )}
      <div style={{ flex: 1 }}>
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
