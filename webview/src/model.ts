/**
 * Pure canvas reducer: ServerEvent -> canvas state. Kept framework-free so the
 * R1 behavior (topology render + active-node highlight) is unit-tested headlessly;
 * React Flow only renders this state. See webview/src/model.test.ts.
 */
import type { ServerEvent } from "../../protocol";

export interface ManualRequest {
  node: string;
  threadId: string | null;
  interruptId: string;
  renderedText: string;
  expects: "text" | "tool_call";
  promptTokens: number;
  toolSchema: unknown | null;
}

/** Per-node token tally for the economy panel (PHASE 4). `estimated` is true if any
 *  measurement fell back to a sidecar estimate (no provider usage_metadata, P8). */
export interface NodeTokens {
  node: string; calls: number; prompt: number; completion: number; estimated: boolean;
  lastPrompt?: string; lastResponse?: string;  // text of the most recent call, for the expandable view
}
interface PendingLlm { node: string; prompt: number; promptText?: string }

export interface DiffEntry { channel: string; op: string; before?: unknown; after?: unknown }
export interface Snapshot { values: Record<string, unknown>; diff: DiffEntry[] }
export interface Paused { node: string; checkpointId: string }

export interface CanvasState {
  nodes: string[];
  edges: [string, string][];
  active: string | null;
  running: boolean;
  error: string | null;
  pending: ManualRequest | null;  // manual inference awaiting a pasted answer
  paused: Paused | null;          // stopped at a breakpoint (debugging)
  snapshot: Snapshot | null;      // state at the current pause
  checkpoints: string[];          // checkpoint ids seen (newest first) for time-travel
  inputSchema: Record<string, unknown> | null;  // graph input JSON Schema for the run form
  projectRoot: string | null;     // project root the graph loaded from, for form defaults
  tokens: Record<string, NodeTokens>;  // per-node token tally for the current run (PHASE 4)
  llmPending: Record<string, PendingLlm>;  // in-flight llm calls by llmEventId (start -> end)
  nodeDocs: Record<string, string | null>;  // first docstring line per node (overview)
  nodeKinds: Record<string, "llm" | "manual">;  // llm = model/API call, manual = interrupt; absent = script
  edgeLabels: Record<string, string>;  // branch condition per conditional edge, keyed "src->tgt"
}

export type NodeKind = "llm" | "manual" | "script";

export const initialState: CanvasState = {
  nodes: [], edges: [], active: null, running: false, error: null, pending: null,
  paused: null, snapshot: null, checkpoints: [], inputSchema: null, projectRoot: null,
  tokens: {}, llmPending: {}, nodeDocs: {}, nodeKinds: {}, edgeLabels: {},
};

/** Node kind: "manual" (pauses for a human paste via interrupt), "llm" (calls a
 *  model/API), or "script". Seeded from the worker's static scan, refined by runtime
 *  events (manual_inference_required -> manual, llm_start -> llm). */
export function nodeKind(state: CanvasState, node: string): NodeKind {
  return state.nodeKinds[node] ?? "script";
}

/** BFS order from __start__ (falls back to input order for unreached nodes), shared by
 *  the canvas layout and the overview table so both read top-to-bottom in flow order. */
export function topoOrder(nodes: string[], edges: [string, string][]): string[] {
  const adj: Record<string, string[]> = {};
  nodes.forEach((n) => (adj[n] = []));
  edges.forEach(([s, t]) => adj[s]?.push(t));
  const start = nodes.includes("__start__") ? "__start__" : nodes[0];
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = start ? [start] : [];
  while (queue.length) {
    const n = queue.shift() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n);
    for (const m of adj[n] ?? []) if (!seen.has(m)) queue.push(m);
  }
  nodes.forEach((n) => { if (!seen.has(n)) order.push(n); });
  return order;
}

export interface OverviewRow { node: string; kind: NodeKind; doc: string | null }

/** Rows for the sidebar overview: real nodes (no __start__/__end__) in flow order. */
export function overviewRows(state: CanvasState): OverviewRow[] {
  return topoOrder(state.nodes, state.edges)
    .filter((n) => n !== "__start__" && n !== "__end__")
    .map((n) => ({ node: n, kind: nodeKind(state, n), doc: state.nodeDocs[n] ?? null }));
}

export interface FormField {
  name: string; type: string; isPath: boolean;
  title?: string; description?: string; placeholder?: string;
}

const PATH_RE = /path|dir|file|out|repo/i;

interface SchemaProp { type?: string; title?: string; description?: string; default?: unknown }

/** Editable top-level fields from the input schema (string/number/boolean);
 *  array/object fields are defaulted (not shown). Carries title/description/default
 *  (from a Pydantic Field(description=…) state) so the form can explain each param. */
export function formFields(schema: Record<string, unknown> | null): FormField[] {
  const props = (schema?.properties ?? {}) as Record<string, SchemaProp>;
  return Object.entries(props)
    .filter(([, p]) => ["string", "integer", "number", "boolean"].includes(p?.type ?? "string"))
    .map(([name, p]) => ({
      name,
      type: p?.type ?? "string",
      isPath: (p?.type ?? "string") === "string" && PATH_RE.test(name),
      title: p?.title,
      description: p?.description,
      placeholder: p?.default !== undefined && p?.default !== null ? String(p.default) : (p?.type ?? "string"),
    }));
}

/** Build the graph input object from form values: typed scalars + empty array/object defaults. */
export function buildInput(
  schema: Record<string, unknown> | null,
  values: Record<string, string>,
): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string }>;
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    const type = p?.type ?? "string";
    const raw = values[name];
    if (type === "array") out[name] = [];
    else if (type === "object") out[name] = {};
    else if (type === "integer" || type === "number") out[name] = raw ? Number(raw) : 0;
    else if (type === "boolean") out[name] = raw === "true";
    else if (raw !== undefined && raw !== "") out[name] = raw;
  }
  return out;
}

/** Pre-fill the run form from the project root so a graph that takes a repo_path /
 *  out_dir starts runnable instead of blank. Path inputs default to the root (an
 *  out/dist/build-ish one to root/out); a non-path "target/name/project" string to
 *  the repo's basename. Schema defaults still win (callers merge user edits on top). */
export function defaultForm(
  fields: FormField[],
  projectRoot: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!projectRoot) return out;
  const root = projectRoot.replace(/[\\/]+$/, "");
  const base = root.split(/[\\/]/).pop() ?? "";
  for (const f of fields) {
    if (f.isPath) {
      out[f.name] = /out|dist|build/i.test(f.name) ? `${root}/out` : root;
    } else if (f.type === "string" && /target|name|project|repo/i.test(f.name)) {
      out[f.name] = base;
    }
  }
  return out;
}

/** Show the "Select Graph" CTA only when no graph is loaded (covers graph_load_failed,
 *  which leaves nodes empty). A run-time error with a graph already on screen keeps the
 *  graph + shows the error banner instead. */
export function needsGraphSelection(state: CanvasState): boolean {
  return state.nodes.length === 0 && !state.running;
}

export interface TokenSummary {
  rows: NodeTokens[];                 // per-node, sorted by total tokens desc
  total: { calls: number; prompt: number; completion: number };
  heaviest: string | null;           // node with the highest total (manual-suggestion target)
  estimated: boolean;                // any row used a sidecar estimate (P8) -> "相對比較" caveat
}

/** Roll up per-node token tallies for the economy panel: sorted rows, run total,
 *  the heaviest node (what a human should look at first), and whether any figure
 *  is an estimate. Pure — unit-tested in model.test.ts. */
export function tokenSummary(state: CanvasState): TokenSummary {
  const tot = (t: NodeTokens) => t.prompt + t.completion;
  const rows = Object.values(state.tokens).sort((a, b) => tot(b) - tot(a));
  const total = rows.reduce(
    (acc, r) => ({ calls: acc.calls + r.calls, prompt: acc.prompt + r.prompt, completion: acc.completion + r.completion }),
    { calls: 0, prompt: 0, completion: 0 },
  );
  return {
    rows, total,
    heaviest: rows.length ? rows[0].node : null,
    estimated: rows.some((r) => r.estimated),
  };
}

export type InspectorTab = "run" | "state" | "tokens" | "manual";

/** Which inspector tab to surface: a manual-inference pause jumps to Manual, a
 *  breakpoint pause to State; otherwise keep whatever tab the user is on. */
export function autoTab(state: CanvasState, current: InspectorTab): InspectorTab {
  if (state.pending) return "manual";
  if (state.paused) return "state";
  return current;
}

export function reduce(state: CanvasState, ev: ServerEvent): CanvasState {
  switch (ev.type) {
    case "graph": {
      // seed node kinds from the worker's static classification; runtime
      // llm_start / manual events refine it. "script" is the absent default.
      const seededKinds: Record<string, "llm" | "manual"> = {};
      for (const [n, k] of Object.entries(ev.nodeKinds ?? {})) {
        if (k === "llm" || k === "manual") seededKinds[n] = k;
      }
      return { ...state, nodes: ev.nodes, edges: ev.edges, error: null,
        inputSchema: ev.inputSchema ?? null, projectRoot: ev.projectRoot ?? null,
        nodeDocs: ev.nodeDocs ?? {}, nodeKinds: seededKinds, edgeLabels: ev.edgeLabels ?? {} };
    }
    case "run_started":
      return { ...state, running: true, active: null, paused: null, snapshot: null,
        tokens: {}, llmPending: {} };
    case "llm_start":
      // buffer the call; its prompt is finalized at llm_end (exact if api_usage arrives).
      // observing a chat-model call marks this node as inference (persists across runs).
      return { ...state, nodeKinds: { ...state.nodeKinds, [ev.node]: "llm" },
        llmPending: { ...state.llmPending,
          [ev.llmEventId]: { node: ev.node, prompt: ev.promptTokens?.prompt ?? 0, promptText: ev.promptText ?? undefined } } };
    case "llm_end": {
      const p = state.llmPending[ev.llmEventId];
      if (!p) return state;  // end without a matching start: ignore
      const apiUsage = ev.tokens?.source === "api_usage";
      const prompt = apiUsage ? (ev.tokens?.prompt ?? 0) : p.prompt;  // exact wins over estimate
      const completion = ev.tokens?.completion ?? 0;
      const prev = state.tokens[p.node] ?? { node: p.node, calls: 0, prompt: 0, completion: 0, estimated: false };
      const rest = { ...state.llmPending };
      delete rest[ev.llmEventId];
      return { ...state,
        tokens: { ...state.tokens, [p.node]: {
          node: p.node, calls: prev.calls + 1,
          prompt: prev.prompt + prompt, completion: prev.completion + completion,
          estimated: prev.estimated || !apiUsage,
          lastPrompt: p.promptText ?? prev.lastPrompt,        // text of the latest call
          lastResponse: ev.completionText ?? prev.lastResponse,
        } },
        llmPending: rest };
    }
    case "node_start":
      // a node (re)starting clears any prior pause (manual resume / step / continue)
      return { ...state, active: ev.node, pending: null, paused: null };
    case "breakpoint_hit":
      return {
        ...state,
        active: ev.node,
        paused: { node: ev.node, checkpointId: ev.checkpointId },
        checkpoints: [ev.checkpointId, ...state.checkpoints.filter((c) => c !== ev.checkpointId)],
      };
    case "state_snapshot":
      return { ...state, snapshot: { values: ev.snapshot.values, diff: ev.snapshot.diff ?? [] } };
    case "node_end":
      return { ...state, active: state.active === ev.node ? null : state.active };
    case "manual_inference_required":
      return {
        ...state,
        nodeKinds: { ...state.nodeKinds, [ev.node]: "manual" },  // observed a manual interrupt
        pending: {
          node: ev.node, threadId: ev.threadId ?? null, interruptId: ev.interruptId,
          renderedText: ev.renderedText, expects: ev.expects,
          promptTokens: ev.promptTokens.prompt, toolSchema: ev.toolSchema ?? null,
        },
      };
    case "run_finished":
      return { ...state, running: false, active: null, pending: null, paused: null, snapshot: null };
    case "error":
      // graph_load_failed (and other sidecar errors) -> surface, don't blank-canvas.
      return { ...state, error: `${ev.code}: ${ev.message}`, running: false };
    default:
      return state;
  }
}
