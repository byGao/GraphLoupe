/**
 * Pure canvas reducer: ServerEvent -> canvas state. Kept framework-free so the
 * R1 behavior (topology render + active-node highlight) is unit-tested headlessly;
 * React Flow only renders this state. See webview/src/model.test.ts.
 */
import type { ServerEvent } from "../../protocol";
import type { RunRecord } from "../../runhistory";
export type { RunRecord } from "../../runhistory";

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
/** One super-step in the run's state timeline (P1-2): the node that ran + its per-channel
 *  diff, reconstructed by the worker from the checkpoint lineage. */
export interface StateStep { seq: number; checkpointId: string; node: string | null; diff: DiffEntry[] }
export interface Paused { node: string; checkpointId: string }

/** One point on the time-travel timeline; `node` is what runs next from here. */
export interface CheckpointRef { checkpointId: string; node: string | null }

/** One router decision reconstructed from the checkpoint lineage (P1-3): at `source`
 *  the conditional edge chose `key` -> `target`; `alternatives` is the full {key: target}
 *  map so the panel can show the paths NOT taken. */
export interface BranchDecision {
  source: string;
  key: string | null;
  target: string;
  alternatives: Record<string, string>;
  stateValues: Record<string, unknown>;
}

export interface CanvasState {
  nodes: string[];
  edges: [string, string][];
  active: string | null;
  running: boolean;
  error: string | null;
  pending: ManualRequest | null;  // manual inference awaiting a pasted answer
  paused: Paused | null;          // stopped at a breakpoint (debugging)
  snapshot: Snapshot | null;      // state at the current pause
  checkpoints: CheckpointRef[];   // time-travel timeline (newest first); click one to rewind
  branchDecisions: BranchDecision[];  // router decisions taken this run (oldest first) (P1-3)
  timeline: StateStep[];  // per-step state evolution this run (oldest first) (P1-2)
  runs: RunRecord[];  // persisted run history, newest first (P1-4); fed by the run_history message
  inputSchema: Record<string, unknown> | null;  // graph input JSON Schema for the run form
  projectRoot: string | null;     // project root the graph loaded from, for form defaults
  tokens: Record<string, NodeTokens>;  // per-node token tally for the current run (PHASE 4)
  llmPending: Record<string, PendingLlm>;  // in-flight llm calls by llmEventId (start -> end)
  nodeDocs: Record<string, string | null>;  // first docstring line per node (overview)
  nodeKinds: Record<string, "llm" | "manual">;  // llm = model/API call, manual = interrupt; absent = script
  edgeLabels: Record<string, string>;  // branch condition per conditional edge, keyed "src->tgt"
  nodeSources: Record<string, { file: string; line: number }>;  // node def file:line for jump-to-source (P1-1)
  hasCheckpointer: boolean | null;  // graph compiled with a checkpointer? — debug availability (P0-5)
  langgraphVersion: string | null;  // langgraph version in the worker's interpreter (P0-5)
  workerPython: string | null;      // interpreter running the graph (sys.executable) (P0-5)
}

export type NodeKind = "llm" | "manual" | "script";

export const initialState: CanvasState = {
  nodes: [], edges: [], active: null, running: false, error: null, pending: null,
  paused: null, snapshot: null, checkpoints: [], branchDecisions: [], timeline: [], runs: [], inputSchema: null, projectRoot: null,
  tokens: {}, llmPending: {}, nodeDocs: {}, nodeKinds: {}, edgeLabels: {}, nodeSources: {},
  hasCheckpointer: null, langgraphVersion: null, workerPython: null,
};

/** Short label for a source location, e.g. {file:"/a/b/graph.py",line:42} -> "graph.py:42".
 *  Pure; used by the overview's jump-to-source affordance (P1-1). */
export function sourceLabel(ref: { file: string; line: number }): string {
  const base = ref.file.split(/[/\\]/).pop() || ref.file;
  return `${base}:${ref.line}`;
}

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

export type InspectorTab = "run" | "state" | "tokens" | "manual" | "health" | "branch" | "history";

/** One row for the Branch panel (P1-3): the decision plus the alternatives NOT taken,
 *  each labelled by its router key, so the user sees which paths were skipped. Pure. */
export interface BranchRow {
  source: string;
  target: string;
  key: string | null;
  notTaken: { key: string; target: string }[];
}
/** One History row's derived fields (P1-4): node path as a readable chain, total tokens, and
 *  run duration in ms. Time-of-day formatting is left to the component (locale-dependent). Pure. */
export interface RunRow { path: string; tokens: number; durationMs: number | null }
export function runSummary(rec: RunRecord): RunRow {
  return {
    path: rec.nodePath.join(" → ") || "(no nodes)",
    tokens: rec.tokens.prompt + rec.tokens.completion,
    durationMs: rec.endedAt === null ? null : rec.endedAt - rec.startedAt,
  };
}

/** A fresh thread id for one ▶ Run (P1-5c). Every run must execute on its own thread so the
 *  worker's lineage-based reconstruction (branches / state timeline / checkpoints) reflects
 *  only that run, not the previous ones on a shared thread. `seq`+`now` keep it unique and
 *  deterministic to test. */
export function makeRunThreadId(seq: number, now: number): string {
  return `run-${now}-${seq}`;
}

/** Toggle a run into/out of the compare selection (P1-5), capped at 2 — selecting a third
 *  drops the oldest so the set is always the two most-recently picked. Pure. */
export function toggleCompare(set: string[], id: string): string[] {
  if (set.includes(id)) return set.filter((x) => x !== id);
  return [...set, id].slice(-2);
}

/** Split the time-travel checkpoint list (newest first) into the current run and the older
 *  runs stacked beneath it (P1-2 UX): re-running the same thread appends prior runs' whole
 *  lineage, so "current" = head down to and including its first `__start__`. Pure. */
export function splitCurrentRun(checkpoints: CheckpointRef[]): { current: CheckpointRef[]; older: CheckpointRef[] } {
  const startIdx = checkpoints.findIndex((c) => c.node === "__start__");
  const boundary = startIdx === -1 ? checkpoints.length : startIdx + 1;
  return { current: checkpoints.slice(0, boundary), older: checkpoints.slice(boundary) };
}

const DIFF_MAXLEN = 40;
/** Summarize a state value for a diff line (P1-2): long strings truncated, list/dict shown
 *  as a count so a big payload doesn't dump raw JSON into the line. Pure. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") return v.length > DIFF_MAXLEN ? v.slice(0, DIFF_MAXLEN) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `list[${v.length}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).length} keys}`;
  return String(v);
}
/** One diff entry as a human-readable line (P1-2): "~ ch: a → b" / "+ ch: v" / "− ch: v".
 *  Shared by the State Diff and Timeline views. Pure. */
export function formatDiffEntry(d: DiffEntry): string {
  const sign = d.op === "add" ? "+" : d.op === "remove" ? "−" : "~";
  const val = d.op === "add" ? formatValue(d.after)
    : d.op === "remove" ? formatValue(d.before)
    : `${formatValue(d.before)} → ${formatValue(d.after)}`;
  return `${sign} ${d.channel}: ${val}`;
}

export function branchRows(state: CanvasState): BranchRow[] {
  return state.branchDecisions.map((d) => ({
    source: d.source, target: d.target, key: d.key,
    notTaken: Object.entries(d.alternatives)
      .filter(([, tgt]) => tgt !== d.target)
      .map(([k, tgt]) => ({ key: k, target: tgt })),
  }));
}

export type HealthStatus = "ok" | "warn" | "info" | "error";
export interface HealthCheck { label: string; status: HealthStatus; detail: string }

const realNodeCount = (state: CanvasState): number =>
  state.nodes.filter((n) => n !== "__start__" && n !== "__end__").length;

/** Compatibility / health checklist derived from the loaded graph (P0-5): what's wired
 *  up (checkpointer, input schema, LLM nodes, node source) and what isn't, so the user
 *  sees it at a glance instead of discovering it feature by feature. Pure. */
export function healthChecks(state: CanvasState): HealthCheck[] {
  if (state.error) {
    // graph_load_failed etc. — show the cause; don't false-ok the rest.
    return [{ label: "Graph loaded", status: "error", detail: state.error }];
  }
  if (state.nodes.length === 0) {
    return [{ label: "Graph loaded", status: "info", detail: "no graph selected yet" }];
  }
  const checks: HealthCheck[] = [
    { label: "Graph loaded", status: "ok", detail: `${realNodeCount(state)} nodes · ${state.edges.length} edges` },
  ];

  if (state.hasCheckpointer === true) {
    checks.push({ label: "Checkpointer", status: "ok", detail: "breakpoints / step / time-travel available" });
  } else if (state.hasCheckpointer === false) {
    checks.push({ label: "Checkpointer", status: "warn", detail: "none — runs to completion; can't pause / step / time-travel. Add compile(checkpointer=…)" });
  }

  const schema = state.inputSchema as { properties?: Record<string, unknown> } | null;
  if (!schema) {
    checks.push({ label: "Run input schema", status: "info", detail: "no schema — use the raw JSON box" });
  } else {
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const total = Object.keys(props).length;
    const described = Object.values(props).filter(
      (p) => p != null && typeof p === "object" && "description" in (p as object)).length;
    checks.push(total > 0 && described < total
      ? { label: "Run input schema", status: "warn", detail: `${total} field(s), ${described} described — add pydantic Field(description=…) for hints` }
      : { label: "Run input schema", status: "ok", detail: `${total} field(s)` });
  }

  const llm = Object.values(state.nodeKinds).filter((k) => k === "llm" || k === "manual").length;
  checks.push(llm > 0
    ? { label: "LLM / inference nodes", status: "ok", detail: `${llm} — token economy / manual inference apply` }
    : { label: "LLM / inference nodes", status: "info", detail: "none detected — script-only graph" });

  const src = Object.keys(state.nodeSources).length;
  checks.push(src > 0
    ? { label: "Node → source", status: "ok", detail: `${src}/${realNodeCount(state)} nodes resolvable` }
    : { label: "Node → source", status: "info", detail: "no source locations (dynamic / lambda nodes)" });

  return checks;
}

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
      // a (re)loaded topology is a clean slate — also clear any run state so that
      // restarting the sidecar (e.g. ■ Stop) doesn't leave the UI stuck "running".
      return { ...state, nodes: ev.nodes, edges: ev.edges, error: null,
        inputSchema: ev.inputSchema ?? null, projectRoot: ev.projectRoot ?? null,
        nodeDocs: ev.nodeDocs ?? {}, nodeKinds: seededKinds, edgeLabels: ev.edgeLabels ?? {},
        nodeSources: ev.nodeSources ?? {},
        hasCheckpointer: ev.hasCheckpointer ?? null, langgraphVersion: ev.langgraphVersion ?? null,
        workerPython: ev.workerPython ?? null,
        running: false, active: null, paused: null, pending: null, snapshot: null,
        tokens: {}, llmPending: {}, checkpoints: [], branchDecisions: [], timeline: [] };
    }
    case "run_started":
      return { ...state, running: true, active: null, paused: null, snapshot: null,
        checkpoints: [], branchDecisions: [], timeline: [], tokens: {}, llmPending: {} };
    case "checkpoint_history":
      return { ...state, checkpoints: ev.checkpoints };
    case "branch_decisions":
      return { ...state, branchDecisions: ev.decisions };
    case "state_timeline":
      return { ...state, timeline: ev.steps };
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
      // keep `snapshot`: the worker emits the final state just before run_finished (P1-5d),
      // so the State Raw/Diff views show the run's result. run_started clears it next run.
      return { ...state, running: false, active: null, pending: null, paused: null };
    case "error":
      // graph_load_failed (and other sidecar errors) -> surface, don't blank-canvas.
      return { ...state, error: `${ev.code}: ${ev.message}`, running: false };
    default:
      return state;
  }
}
