import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { initialState, reduce, type CanvasState } from "./model";
import type { ServerEvent } from "../../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

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

  const nodes: Node[] = useMemo(
    () =>
      state.nodes.map((id, i) => ({
        id,
        position: { x: i * 180, y: 80 },
        data: { label: id },
        style:
          id === state.active
            ? { border: "2px solid #3fb950", background: "#10301a", color: "#56d364" }
            : undefined,
      })),
    [state.nodes, state.active],
  );

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
      <div style={{ flex: 1 }}>
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
