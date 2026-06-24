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
}

export const initialState: CanvasState = {
  nodes: [], edges: [], active: null, running: false, error: null, pending: null,
  paused: null, snapshot: null, checkpoints: [],
};

/** Show the "Select Graph" CTA only when no graph is loaded (covers graph_load_failed,
 *  which leaves nodes empty). A run-time error with a graph already on screen keeps the
 *  graph + shows the error banner instead. */
export function needsGraphSelection(state: CanvasState): boolean {
  return state.nodes.length === 0 && !state.running;
}

export function reduce(state: CanvasState, ev: ServerEvent): CanvasState {
  switch (ev.type) {
    case "graph":
      return { ...state, nodes: ev.nodes, edges: ev.edges, error: null };
    case "run_started":
      return { ...state, running: true, active: null, paused: null, snapshot: null };
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
