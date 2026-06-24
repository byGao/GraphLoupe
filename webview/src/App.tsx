import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  initialState, needsGraphSelection, reduce,
  type CanvasState, type ManualRequest, type Paused, type Snapshot,
} from "./model";
import type { ServerEvent } from "../../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

/** Post a StartRun with the user-supplied JSON input (your graph's initial state). */
function sendRun(inputText: string): void {
  let input: unknown = {};
  try {
    input = JSON.parse(inputText || "{}");
  } catch {
    input = {};
  }
  vscode.postMessage({ v: "0.1.0", corr: null, type: "start_run", threadId: null, input, providerMode: "manual" });
}

/** Post a Resume ClientCommand (text or tool_call) back through the extension/sidecar. */
function sendResume(p: ManualRequest, draft: string): void {
  let payload: unknown;
  if (p.expects === "text") {
    payload = { kind: "text", text: draft };
  } else {
    let args: unknown = {};
    try {
      args = JSON.parse(draft || "{}");
    } catch {
      args = {};
    }
    payload = { kind: "tool_call", name: "tool", args };
  }
  vscode.postMessage({
    v: "0.1.0", corr: null, type: "resume",
    threadId: p.threadId, interruptId: p.interruptId, payload,
  });
}

function postCmd(msg: Record<string, unknown>): void {
  vscode.postMessage({ v: "0.1.0", corr: null, ...msg });
}

function DebugPanel({ paused, snapshot }: { paused: Paused; snapshot: Snapshot | null }) {
  const [override, setOverride] = useState("");
  return (
    <div style={{ borderTop: "1px solid #30363d", background: "#11161d", padding: "10px 14px", maxHeight: "45%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <strong style={{ color: "#79c0ff" }}>‖ paused @ {paused.node}</strong>
        <span style={{ color: "#6e7681", fontSize: 12 }}>checkpoint {paused.checkpointId.slice(0, 8)}</span>
        <button style={{ marginLeft: "auto", fontSize: 12 }} onClick={() => postCmd({ type: "step", threadId: "run", runId: "run" })}>⏭ Step</button>
        <button style={{ fontSize: 12 }} onClick={() => postCmd({ type: "start_run", threadId: null, input: {}, providerMode: "manual" })}>▶ Continue</button>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 2 }}>State</div>
          <pre style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: 8, fontSize: 11, whiteSpace: "pre-wrap", margin: 0, maxHeight: 140, overflow: "auto" }}>
            {snapshot ? JSON.stringify(snapshot.values, null, 2) : "…"}
          </pre>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 2 }}>Diff (last super-step)</div>
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: 8, fontSize: 11, maxHeight: 80, overflow: "auto" }}>
            {(snapshot?.diff ?? []).map((d, i) => (
              <div key={i} style={{ color: d.op === "add" ? "#3fb950" : d.op === "remove" ? "#f85149" : "#d29922" }}>
                {d.op === "add" ? "+" : d.op === "remove" ? "−" : "~"} {d.channel}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <input
              value={override} onChange={(e) => setOverride(e.target.value)} spellCheck={false}
              placeholder='override JSON (optional)'
              style={{ flex: 1, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, padding: "3px 6px", fontFamily: "monospace", fontSize: 11 }}
            />
            <button style={{ fontSize: 12 }} onClick={() => {
              let stateOverride: unknown = null;
              if (override.trim()) { try { stateOverride = JSON.parse(override); } catch { stateOverride = null; } }
              postCmd({ type: "fork", threadId: "run", checkpointId: paused.checkpointId, stateOverride });
            }}>Fork ↩</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManualPanel({ pending }: { pending: ManualRequest }) {
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(""), [pending.interruptId]);
  const isText = pending.expects === "text";
  return (
    <div style={{ borderTop: "1px solid #30363d", background: "#11161d", padding: "10px 14px", maxHeight: "45%", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <strong style={{ color: "#d29922" }}>Manual inference</strong>
        <span style={{ color: "#6e7681", fontSize: 12 }}>
          node: {pending.node} · prompt ~{pending.promptTokens} tok (sidecar est) · expects: {pending.expects}
        </span>
        <button style={{ marginLeft: "auto", fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(pending.renderedText)}>
          Copy prompt
        </button>
      </div>
      <pre style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: 8, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
        {pending.renderedText}
      </pre>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={isText ? "Paste the model's response…" : 'Paste tool args as JSON, e.g. {"query": "…"}'}
        style={{ width: "100%", minHeight: 56, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, padding: 8, fontFamily: "monospace", fontSize: 12 }}
      />
      <button style={{ marginTop: 6, padding: "6px 14px", fontSize: 13 }} onClick={() => sendResume(pending, draft)}>
        Send resume
      </button>
    </div>
  );
}

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

export default function App() {
  const [state, setState] = useState<CanvasState>(initialState);
  const [inputText, setInputText] = useState("{}");
  const [breakpoints, setBreakpoints] = useState<Set<string>>(new Set());

  const toggleBreakpoint = (node: string) => {
    setBreakpoints((bps) => {
      const next = new Set(bps);
      const on = !next.has(node);
      if (on) next.add(node); else next.delete(node);
      postCmd({ type: on ? "set_breakpoint" : "clear_breakpoint", node, when: "before" });
      return next;
    });
  };

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
      style: {
        ...(id === state.active
          ? { border: "2px solid #3fb950", background: "#10301a", color: "#56d364" }
          : {}),
        ...(breakpoints.has(id) ? { boxShadow: "0 0 0 2px #f85149" } : {}),
      },
    }));
  }, [state.nodes, state.edges, state.active, breakpoints]);

  const edges: Edge[] = useMemo(
    () => state.edges.map(([s, t], i) => ({ id: `e${i}`, source: s, target: t })),
    [state.edges],
  );

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #30363d", display: "flex", alignItems: "center", gap: 8 }}>
        <button disabled={state.running} onClick={() => sendRun(inputText)}>
          ▶ Run
        </button>
        <input
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          spellCheck={false}
          title="Initial state for your graph, as JSON (e.g. {&quot;repo_path&quot;: &quot;…&quot;})"
          placeholder='input JSON, e.g. {"repo_path": "…"}'
          style={{ flex: 1, maxWidth: 460, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, padding: "4px 8px", fontFamily: "monospace", fontSize: 12 }}
        />
        <span style={{ color: "#8b949e", fontSize: 12, whiteSpace: "nowrap" }}>
          read-only{state.running ? " · running" : ""}
        </span>
      </div>
      {state.error && (
        <div style={{ padding: "8px 12px", background: "#3d1518", borderBottom: "1px solid #6b2020", color: "#ff7b72", fontSize: 13 }}>
          ⚠ {state.error}
        </div>
      )}
      <div style={{ flex: 1, position: "relative" }}>
        <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, n) => toggleBreakpoint(n.id)}>
          <Background />
          <Controls />
        </ReactFlow>
        {needsGraphSelection(state) && !state.pending && (
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 12,
              background: "rgba(13,17,23,0.85)", textAlign: "center",
            }}
          >
            <div style={{ color: "#8b949e" }}>
              {state.error ? "Couldn't load that graph." : "No graph selected."}
            </div>
            <button
              style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}
              onClick={() => vscode.postMessage({ type: "ui:selectGraph" })}
            >
              Select Graph…
            </button>
            <div style={{ color: "#6e7681", fontSize: 12, maxWidth: 380 }}>
              Picks a <code>build_graph()</code> in your project — no settings to edit.
            </div>
          </div>
        )}
      </div>
      {state.pending && <ManualPanel pending={state.pending} />}
      {state.paused && !state.pending && <DebugPanel paused={state.paused} snapshot={state.snapshot} />}
    </div>
  );
}
