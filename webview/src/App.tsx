import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ReactFlow, BaseEdge, Background, Controls, MarkerType, Position,
  useNodesState,
  type Node, type Edge, type EdgeProps, type EdgeTypes, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  autoTab, buildInput, defaultForm, formFields, healthChecks, initialState, needsGraphSelection, nodeKind,
  overviewRows, reduce, sourceLabel, tokenSummary,
  type CanvasState, type CheckpointRef, type HealthCheck, type InspectorTab, type ManualRequest, type Paused, type Snapshot,
} from "./model";
import { elkLayout, type GraphLayout, type Pt } from "./layout";
import type { ServerEvent } from "../../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// GraphLoupe's own version (package.json → GitHub Release), baked in by esbuild; "dev"
// under vitest/no-define. Distinct from the langgraph version the worker reports.
declare const __GL_VERSION__: string;
const GL_VERSION = typeof __GL_VERSION__ !== "undefined" ? __GL_VERSION__ : "dev";

/** Post a StartRun with the graph's initial-state input object. */
function sendRunObject(input: unknown): void {
  vscode.postMessage({ v: "0.1.0", corr: null, type: "start_run", threadId: null, input, providerMode: "manual" });
}

function sendRun(inputText: string): void {
  let input: unknown = {};
  try {
    input = JSON.parse(inputText || "{}");
  } catch {
    input = {};
  }
  sendRunObject(input);
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

// Time-travel timeline: every checkpoint on the thread (newest first). Click one to
// rewind — the worker forks from it and re-runs to the next pause.
function CheckpointTimeline({ checkpoints }: { checkpoints: CheckpointRef[] }) {
  return (
    <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>⏱ Time travel</strong>
        <span style={{ color: "#6e7681", fontSize: 11 }}>click a checkpoint to rewind &amp; re-run</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {checkpoints.map((c, i) => {
          const now = i === 0;  // newest = the current head
          return (
            <button key={c.checkpointId}
              disabled={now}
              onClick={() => postCmd({ type: "fork", threadId: "run", checkpointId: c.checkpointId })}
              title={now ? "current position" : `rewind to before ${c.node ?? "end"}`}
              style={{
                display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                border: "none", borderRadius: 4, padding: "4px 8px", fontSize: 12,
                background: now ? "var(--surface-2)" : "transparent",
                color: now ? "var(--text)" : "var(--muted)",
                cursor: now ? "default" : "pointer",
              }}>
              <span style={{ color: now ? "var(--pause)" : "#6e7681" }}>{now ? "▶" : "↩"}</span>
              <span style={{ flex: 1 }}>{c.node ? `before ${c.node}` : "end"}</span>
              {/* show the suffix: time-ordered uuids share a prefix, so the head differs */}
              <span style={{ color: "#6e7681", fontFamily: "monospace", fontSize: 11 }}>…{c.checkpointId.slice(-6)}</span>
              {now && <span style={{ color: "var(--pause)", fontSize: 11 }}>now</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DebugPanel({ paused, snapshot }: { paused: Paused; snapshot: Snapshot | null }) {
  const [override, setOverride] = useState("");
  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <strong style={{ color: "var(--pause)" }}>‖ paused @ {paused.node}</strong>
        <span style={{ color: "#6e7681", fontSize: 12 }}>checkpoint {paused.checkpointId.slice(0, 8)}</span>
        <button style={{ marginLeft: "auto", fontSize: 12 }} onClick={() => postCmd({ type: "step", threadId: "run", runId: "run" })}>⏭ Step</button>
        <button style={{ fontSize: 12 }} onClick={() => postCmd({ type: "start_run", threadId: null, input: {}, providerMode: "manual" })}>▶ Continue</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
            <div style={{ color: "#8b949e", fontSize: 11 }}>State</div>
            <button style={{ marginLeft: "auto", fontSize: 11 }}
              disabled={!snapshot}
              onClick={() => snapshot && navigator.clipboard?.writeText(JSON.stringify(snapshot.values, null, 2))}>
              Copy
            </button>
          </div>
          <pre style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: 8, fontSize: 11, whiteSpace: "pre-wrap", margin: 0, maxHeight: 200, overflow: "auto", userSelect: "text" }}>
            {snapshot ? JSON.stringify(snapshot.values, null, 2) : "…"}
          </pre>
        </div>
        <div>
          <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 2 }}>Diff (last super-step)</div>
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: 8, fontSize: 11, maxHeight: 80, overflow: "auto" }}>
            {(snapshot?.diff ?? []).length === 0 && <span className="gl-help">no changes</span>}
            {(snapshot?.diff ?? []).map((d, i) => (
              <div key={i} style={{ color: d.op === "add" ? "#3fb950" : d.op === "remove" ? "#f85149" : "#d29922" }}>
                {d.op === "add" ? "+" : d.op === "remove" ? "−" : "~"} {d.channel}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 2 }}>
              Fork from here — optional channel updates (JSON):
            </div>
            <textarea
              value={override} onChange={(e) => setOverride(e.target.value)} spellCheck={false}
              placeholder={'e.g. {"steps": 0}  — applied on top of this checkpoint\'s state'}
              style={{ width: "100%", minHeight: 48, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, padding: 6, fontFamily: "monospace", fontSize: 11 }}
            />
            <button style={{ marginTop: 4, fontSize: 12 }} onClick={() => {
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
    <div style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <strong style={{ color: "var(--pause)" }}>Manual inference</strong>
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

/** Token economy panel (PHASE 4): per-node prompt/completion + run total, heaviest
 *  node flagged as the manual-optimization target. Hidden until a run emits LLM events
 *  (graphs with no LLM node simply show nothing). */
const HEALTH_ICON: Record<HealthCheck["status"], { mark: string; color: string }> = {
  ok: { mark: "✓", color: "var(--go)" },
  warn: { mark: "!", color: "var(--pause)" },
  info: { mark: "i", color: "#6cb6ff" },
  error: { mark: "✕", color: "var(--danger)" },
};

/** Health / compatibility checklist for the loaded graph (P0-5): what's wired up and
 *  what isn't, so the user doesn't discover it feature by feature. */
function HealthPanel({ checks, version }: { checks: HealthCheck[]; version: string | null }) {
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div style={{ color: "var(--pause)", fontWeight: 600, fontSize: 13 }}>Graph health</div>
        <div style={{ color: "#6e7681", fontSize: 11, textAlign: "right" }}>
          GraphLoupe {GL_VERSION}{version ? ` · langgraph ${version}` : ""}
        </div>
      </div>
      {checks.map((c, i) => {
        const ic = HEALTH_ICON[c.status];
        return (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <span style={{ color: ic.color, flex: "0 0 auto", width: 12, textAlign: "center", fontWeight: 700 }}>{ic.mark}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#eaf0f7", fontSize: 12.5 }}>{c.label}</div>
              <div style={{ color: "#8b949e", fontSize: 11, lineHeight: 1.45, marginTop: 2 }}>{c.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TokenPanel({ state }: { state: CanvasState }) {
  const s = useMemo(() => tokenSummary(state), [state]);
  const [open, setOpen] = useState<string | null>(null);
  const num: CSSProperties = { textAlign: "right", padding: "2px 8px", fontFamily: "var(--mono)" };
  const head: CSSProperties = { ...num, color: "var(--muted)", fontWeight: 400 };
  const detail: CSSProperties = {
    background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: 6,
    fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto", margin: "2px 0", userSelect: "text",
  };
  if (s.rows.length === 0) {
    return <div className="gl-help" style={{ padding: "12px" }}>No LLM calls yet — run a graph with an LLM node to see per-node token economy.</div>;
  }
  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <strong style={{ color: "var(--pause)" }}>⟁ Token economy</strong>
        {s.heaviest && (
          <span className="gl-help">heaviest: <span className="gl-node">{s.heaviest}</span>
            {s.estimated ? " · est." : ""}</span>
        )}
      </div>
      {(
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: "left" }}>node</th>
              <th style={head}>calls</th><th style={head}>prompt</th>
              <th style={head}>completion</th><th style={head}>total</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => {
              const hasText = !!(r.lastPrompt || r.lastResponse);
              const isOpen = open === r.node;
              return (
                <Fragment key={r.node}>
                  <tr style={{ cursor: hasText ? "pointer" : "default" }}
                    onClick={() => hasText && setOpen(isOpen ? null : r.node)}>
                    <td style={{ padding: "2px 8px", fontFamily: "var(--mono)", color: r.node === s.heaviest ? "var(--pause)" : "var(--text)" }}>
                      {hasText ? (isOpen ? "▾ " : "▸ ") : ""}{r.node}{r.estimated ? " ~" : ""}
                    </td>
                    <td style={num}>{r.calls}</td>
                    <td style={num}>{r.prompt}</td>
                    <td style={num}>{r.completion}</td>
                    <td style={{ ...num, color: "var(--node)" }}>{r.prompt + r.completion}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} style={{ padding: "2px 8px" }}>
                        <div className="gl-help">prompt (last call)</div>
                        <div style={detail}>{r.lastPrompt || "—"}</div>
                        <div className="gl-help">response</div>
                        <div style={detail}>{r.lastResponse || "—"}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            <tr style={{ borderTop: "1px solid var(--line)" }}>
              <td style={{ padding: "3px 8px", color: "var(--muted)" }}>run 累計</td>
              <td style={{ ...num, color: "var(--muted)" }}>{s.total.calls}</td>
              <td style={{ ...num, color: "var(--muted)" }}>{s.total.prompt}</td>
              <td style={{ ...num, color: "var(--muted)" }}>{s.total.completion}</td>
              <td style={{ ...num, color: "var(--run)" }}>{s.total.prompt + s.total.completion}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// node-kind visuals: ⚡ llm (model/API call) vs ✋ manual (interrupt → human paste) vs script
const KIND: Record<"llm" | "manual" | "script", { icon: string; color: string }> = {
  llm: { icon: "⚡ ", color: "var(--accent)" },
  manual: { icon: "✋ ", color: "var(--pause)" },
  script: { icon: "", color: "var(--line)" },
};

const NODE_W = 190;
/** FIXED box per node — fed to ELK *and* applied as the rendered height, so edge
 *  routes (computed for these sizes) line up with the actual node borders. The
 *  purpose text is clamped to fit, so content never grows the node past this. */
function nodeSize(state: CanvasState, id: string): { w: number; h: number } {
  const synthetic = id === "__start__" || id === "__end__";
  return { w: NODE_W, h: synthetic ? 40 : state.nodeDocs[id] ? 96 : 48 };
}

/** Draws ELK's exact orthogonal route (data.points) so edges never overlap or cut
 *  through a node. Label sits at the route's midpoint with a halo for legibility. */
function OrthEdge({ data, markerEnd, style, label }: EdgeProps) {
  const points = (data as { points?: Pt[] } | undefined)?.points ?? [];
  if (points.length < 2) return null;
  const d = points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const mid = points[Math.floor((points.length - 1) / 2)];
  return (
    <>
      <BaseEdge path={d} markerEnd={markerEnd} style={style} />
      {label && (
        <text
          x={mid.x} y={mid.y - 4} textAnchor="middle"
          fontFamily="var(--mono)" fontSize={10}
          fill={(style?.stroke as string) === "#e3b341" ? "#e3b341" : "var(--pause)"}
          style={{ stroke: "var(--surface-2)", strokeWidth: 3, paintOrder: "stroke" }}
        >
          {label as string}
        </text>
      )}
    </>
  );
}

const edgeTypes: EdgeTypes = { orth: OrthEdge };

/** Sidebar overview: graph title + node count + per-node {kind, name, purpose};
 *  clicking a row centers + highlights that node on the canvas (R-04). */
function OverviewPanel(
  { state, focused, onPick }: { state: CanvasState; focused: string | null; onPick: (id: string) => void },
) {
  const rows = useMemo(() => overviewRows(state), [state]);
  const title = (state.projectRoot?.replace(/[\\/]+$/, "").split(/[\\/]/).pop()) || "Graph";
  return (
    <div style={{ width: 244, flex: "0 0 244px", borderRight: "1px solid var(--line)", background: "var(--surface)", overflow: "auto", padding: "12px 14px" }}>
      <div style={{ color: "var(--pause)", fontWeight: 600, marginBottom: 3, fontSize: 14 }}>⌑ {title}</div>
      <div style={{ color: "#aeb9c7", fontSize: 11, marginBottom: 12 }}>{rows.length} nodes · {state.edges.length} edges</div>
      {rows.map((r) => (
        <div
          key={r.node}
          onClick={() => onPick(r.node)}
          style={{
            padding: "9px 11px", borderRadius: 7, cursor: "pointer", marginBottom: 9,
            background: r.node === focused ? "rgba(108,182,255,0.16)" : "var(--surface-2)",
            borderLeft: `3px solid ${KIND[r.kind].color}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600, color: "#eaf0f7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {KIND[r.kind].icon}{r.node}
            </div>
            {state.nodeSources[r.node] && (
              <button
                title={`Open ${sourceLabel(state.nodeSources[r.node])}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const ref = state.nodeSources[r.node];
                  vscode.postMessage({ type: "ui:openSource", file: ref.file, line: ref.line });
                }}
                style={{ flex: "0 0 auto", background: "transparent", border: "none", color: "var(--node)", cursor: "pointer", fontSize: 13, padding: "0 2px", lineHeight: 1 }}
              >↗</button>
            )}
          </div>
          {r.doc && (
            <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: "#b6c2d0" }}>{r.doc}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<CanvasState>(initialState);
  const [inputText, setInputText] = useState("{}");
  const [form, setForm] = useState<Record<string, string>>({});
  const [showRaw, setShowRaw] = useState(false);
  const [breakpoints, setBreakpoints] = useState<Set<string>>(new Set());
  const [showOverview, setShowOverview] = useState(true);
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("run");
  const rf = useRef<ReactFlowInstance | null>(null);

  // a manual-inference / breakpoint pause auto-surfaces the relevant inspector tab
  useEffect(() => { setTab((t) => autoTab(state, t)); }, [state.pending, state.paused]);

  // ELK runs its solver async; only re-layout when the topology (not the run
  // highlight) changes. Keyed on nodes+edges+docs so a run doesn't reflow.
  const [layout, setLayout] = useState<GraphLayout>({ pos: {}, routes: {} });
  const topoKey = useMemo(
    () => JSON.stringify([state.nodes, state.edges, state.nodeDocs]),
    [state.nodes, state.edges, state.nodeDocs],
  );
  useEffect(() => {
    let live = true;
    elkLayout(state.nodes, state.edges, (n) => nodeSize(state, n))
      .then((gl) => { if (live) setLayout(gl); })
      .catch((err) => console.error("[graphloupe] layout", err));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey]);
  const positions = layout.pos;

  // ELK resolves async, after the initial `fitView` has already run on an empty
  // canvas — so refit once the laid-out nodes exist (only on a new layout, i.e.
  // graph load; topology is stable during a run, so this never yanks a live view).
  useEffect(() => {
    if (Object.keys(layout.pos).length > 0) {
      requestAnimationFrame(() => rf.current?.fitView({ duration: 300 }));
    }
  }, [layout]);

  // pan to centre the node at the CURRENT zoom (don't zoom into it — fitView on a
  // single node framed it full-screen and pushed every other node off-screen).
  const focusNode = (id: string) => {
    const p = positions[id];
    if (p && rf.current) {
      const z = rf.current.getViewport().zoom;
      rf.current.setCenter(p.x + NODE_W / 2, p.y + nodeSize(state, id).h / 2, { zoom: z, duration: 400 });
    }
    setFocused(id);
  };

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
      const msg = e.data as { type?: string; field?: string; path?: string };
      if (msg?.type === "folderPicked" && msg.field) {
        const field = msg.field;
        setForm((f) => ({ ...f, [field]: msg.path ?? "" }));
        return;
      }
      const ev = e.data as ServerEvent;
      if (ev && typeof ev.type === "string") {
        setState((s) => reduce(s, ev));
        if (ev.type === "graph") {
          const seeded = defaultForm(formFields(ev.inputSchema ?? null), ev.projectRoot ?? null);
          setForm((f) => ({ ...seeded, ...f }));  // pre-fill, but keep any user edits
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const nodes: Node[] = useMemo(() => {
    const real: Node[] = state.nodes.filter((id) => positions[id]).map((id) => {
      const kind = nodeKind(state, id);
      const doc = state.nodeDocs[id];
      const synthetic = id === "__start__" || id === "__end__";
      return {
        id,
        position: positions[id],
        data: {
          label: (
            <div style={{ textAlign: "left" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600, color: id === state.active ? "var(--run)" : "#eaf0f7" }}>
                {KIND[kind].icon}{id}
              </div>
              {doc && (
                <div style={{
                  fontFamily: "var(--sans)", fontSize: 10.5, color: "#aab6c4", marginTop: 4, lineHeight: 1.4,
                  display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
                }}>
                  {doc}
                </div>
              )}
            </div>
          ),
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        style: {
          width: NODE_W, height: nodeSize(state, id).h, overflow: "hidden",
          textAlign: "left", padding: synthetic ? "5px 10px" : "8px 11px",
          borderColor: KIND[kind].color,
          ...(id === state.active ? { border: "2px solid var(--run)", background: "rgba(76,195,138,0.14)" } : {}),
          ...(id === focused ? { boxShadow: "0 0 0 2px var(--node)" } : {}),
          ...(breakpoints.has(id) ? { boxShadow: "0 0 0 2px var(--danger)" } : {}),
        },
      };
    });
    return real;
  }, [state.nodes, state.nodeDocs, state.nodeKinds, state.active, positions, focused, breakpoints]);

  const edges: Edge[] = useMemo(() => {
    // ELK already routes every edge orthogonally and avoids nodes/overlaps — so we
    // draw its route for ALL edges (a hand-rolled loop bow interfered with the
    // other edges). A back edge (target laid out above its source) is just coloured
    // amber + ↺ so it reads as a return path.
    return state.edges.map(([s, t], i) => {
      const key = `${s}->${t}`;
      const rawLabel = state.edgeLabels[key];
      const sp = positions[s], tp = positions[t];
      const isLoop = !!sp && !!tp && tp.y < sp.y - 1;
      const color = isLoop ? "#e3b341" : "#6b7785";
      const label = isLoop ? `↺ ${rawLabel ?? "loop"}` : rawLabel;
      return {
        id: `e${i}`, source: s, target: t, type: "orth", label,
        data: { points: layout.routes[key] },
        zIndex: isLoop ? 20 : 1,
        style: { stroke: color, strokeWidth: isLoop ? 2 : 1.6, strokeDasharray: rawLabel ? "6 3" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      };
    });
  }, [state.edges, state.edgeLabels, layout.routes, positions]);

  // React Flow v12: NODES are controlled via useNodesState + onNodesChange —
  // passing `nodes` without a handler desyncs RF's store after measurement/fitView
  // and drops nodes (the "nodes vanish" bug). EDGES stay a plain prop: they're
  // drawn by our OrthEdge from ELK route points, and routing them through
  // useEdgesState made RF skip them while nodes re-measured (edges vanished).
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  // MERGE rather than replace: clicking a node recomputes `nodes` (breakpoint/focus
  // style), and a wholesale setRfNodes(nodes) would drop RF's `measured` dimensions —
  // un-measured nodes render at zero size and vanish (and their edges with them). Keep
  // RF's measured size + selection, refresh only what we drive (position/data/style).
  useEffect(() => {
    setRfNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      return nodes.map((n) => {
        const old = byId.get(n.id);
        return old ? { ...old, position: n.position, data: n.data, style: n.style } : n;
      });
    });
  }, [nodes, setRfNodes]);

  const runGraph = () =>
    state.inputSchema && !showRaw
      ? sendRunObject(buildInput(state.inputSchema, form))
      : sendRun(inputText);

  const health = healthChecks(state);
  const TABS: { id: InspectorTab; label: string; dot?: boolean }[] = [
    { id: "run", label: "Input" },
    { id: "state", label: "State", dot: !!state.paused },
    { id: "tokens", label: "Tokens" },
    { id: "manual", label: "Manual", dot: !!state.pending },
    { id: "health", label: "Health", dot: health.some((c) => c.status === "warn" || c.status === "error") },
  ];

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      {/* toolbar */}
      <div style={{ padding: 8, borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
        <button disabled={state.running} onClick={runGraph}>▶ Run</button>
        {(state.running || state.paused || state.pending) && (
          <button onClick={() => postCmd({ type: "cancel", threadId: "run", runId: "run" })}
            title="Abort the current run (keeps the graph loaded)"
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>■ Stop</button>
        )}
        <span style={{ color: "#8b949e", fontSize: 12 }}>read-only{state.running ? " · running" : ""}</span>
        <button style={{ marginLeft: "auto", fontSize: 12 }}
          title="Pick which compiled LangGraph in your project to load"
          onClick={() => vscode.postMessage({ type: "ui:selectGraph" })}>📂 Select graph…</button>
        <button style={{ fontSize: 12 }} onClick={() => setShowOverview((o) => !o)}>⌑ Overview</button>
      </div>
      {state.error && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "rgba(240,114,107,0.12)", borderBottom: "1px solid var(--danger)", color: "var(--danger)", fontSize: 13 }}>
          <span style={{ flex: 1 }}>⚠ {state.error}</span>
          <button
            title="Dismiss"
            onClick={() => setState((s) => ({ ...s, error: null }))}
            style={{ flex: "0 0 auto", background: "transparent", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 4px" }}
          >✕</button>
        </div>
      )}

      {/* main row: overview | canvas | inspector */}
      <div style={{ flex: 1, position: "relative", display: "flex", minHeight: 0 }}>
        {showOverview && state.nodes.length > 0 && (
          <OverviewPanel state={state} focused={focused} onPick={focusNode} />
        )}

        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <ReactFlow
            nodes={rfNodes} edges={edges} edgeTypes={edgeTypes} fitView
            onNodesChange={onNodesChange}
            nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
            onInit={(inst) => { rf.current = inst; }}
            onNodeClick={(_, n) => toggleBreakpoint(n.id)}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          {state.nodes.length > 0 && (
            <div style={{
              position: "absolute", top: 10, right: 10, display: "flex", gap: 12, alignItems: "center",
              padding: "5px 10px", borderRadius: 7, background: "var(--surface)", border: "1px solid var(--line)",
              fontSize: 11, color: "var(--muted)", pointerEvents: "none",
            }}>
              <span><span style={{ display: "inline-block", width: 10, height: 10, border: "1px solid var(--line)", borderRadius: 2, verticalAlign: "middle", marginRight: 5 }} />script</span>
              <span style={{ color: "var(--accent)" }}><span style={{ display: "inline-block", width: 10, height: 10, border: "1px solid var(--accent)", borderRadius: 2, verticalAlign: "middle", marginRight: 5 }} />⚡ llm</span>
              <span style={{ color: "var(--pause)" }}><span style={{ display: "inline-block", width: 10, height: 10, border: "1px solid var(--pause)", borderRadius: 2, verticalAlign: "middle", marginRight: 5 }} />✋ manual</span>
              <span style={{ color: "var(--pause)" }}>— — branch</span>
              <span style={{ color: "#e3b341" }}>↺ loop</span>
            </div>
          )}
          {needsGraphSelection(state) && !state.pending && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 12,
              background: "rgba(13,17,23,0.85)", textAlign: "center",
            }}>
              <div style={{ color: "#8b949e" }}>{state.error ? "Couldn't load that graph." : "No graph selected."}</div>
              <button style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer" }}
                onClick={() => vscode.postMessage({ type: "ui:selectGraph" })}>
                Select Graph…
              </button>
              <div style={{ color: "#6e7681", fontSize: 12, maxWidth: 380 }}>
                Picks a <code>build_graph()</code> in your project — no settings to edit.
              </div>
            </div>
          )}
        </div>

        {/* right inspector */}
        <div style={{ width: 330, flex: "0 0 330px", borderLeft: "1px solid var(--line)", background: "var(--surface)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", borderBottom: "1px solid var(--line)" }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{
                  flex: 1, border: "none", borderRadius: 0, background: tab === t.id ? "var(--surface-2)" : "transparent",
                  color: tab === t.id ? "var(--text)" : "var(--muted)", padding: "7px 4px", fontSize: 12,
                  borderBottom: tab === t.id ? "2px solid var(--node)" : "2px solid transparent",
                }}>
                {t.label}{t.dot ? " ●" : ""}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {tab === "run" && (
              <div style={{ padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
                  <strong style={{ fontSize: 12 }}>Run input</strong>
                  {state.inputSchema && (
                    <button style={{ marginLeft: "auto", fontSize: 11 }} onClick={() => setShowRaw((r) => !r)}>
                      {showRaw ? "Form" : "JSON"}
                    </button>
                  )}
                </div>
                {!state.inputSchema ? (
                  <div className="gl-help">Select a graph to see its inputs.</div>
                ) : !showRaw ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {formFields(state.inputSchema).map((f) => (
                      <div key={f.name}>
                        <label style={{ display: "block", fontSize: 12, marginBottom: 3 }} title={f.title}>{f.name}</label>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            style={{ flex: 1, minWidth: 0 }}
                            value={form[f.name] ?? ""}
                            onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                            type={f.type === "integer" || f.type === "number" ? "number" : "text"}
                            placeholder={f.placeholder}
                            spellCheck={false}
                          />
                          {f.isPath && (
                            <button onClick={() => vscode.postMessage({ type: "ui:pickFolder", field: f.name })}>…</button>
                          )}
                        </div>
                        {f.description && <div className="gl-help" style={{ marginTop: 2 }}>{f.description}</div>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <textarea
                    style={{ width: "100%", minHeight: 120 }}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    spellCheck={false}
                    placeholder='input JSON, e.g. {"repo_path": "…"}'
                  />
                )}
              </div>
            )}
            {tab === "state" && (
              <>
                {state.checkpoints.length > 0 && <CheckpointTimeline checkpoints={state.checkpoints} />}
                {state.paused
                  ? <DebugPanel paused={state.paused} snapshot={state.snapshot} />
                  : state.checkpoints.length === 0 && (
                    <div className="gl-help" style={{ padding: 12 }}>Not paused. Click a node on the canvas to set a breakpoint, then Run — state and diff show here.</div>
                  )}
              </>
            )}
            {tab === "tokens" && <TokenPanel state={state} />}
            {tab === "manual" && (
              state.pending
                ? <ManualPanel pending={state.pending} />
                : <div className="gl-help" style={{ padding: 12 }}>No pending manual inference. When a node calls interrupt(), its prompt appears here to copy → answer → resume.</div>
            )}
            {tab === "health" && <HealthPanel checks={health} version={state.langgraphVersion} />}
          </div>
        </div>
      </div>
    </div>
  );
}
