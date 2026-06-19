/**
 * Pure canvas reducer: ServerEvent -> canvas state. Kept framework-free so the
 * R1 behavior (topology render + active-node highlight) is unit-tested headlessly;
 * React Flow only renders this state. See webview/src/model.test.ts.
 */
import type { ServerEvent } from "../../protocol";

export interface CanvasState {
  nodes: string[];
  edges: [string, string][];
  active: string | null;
  running: boolean;
  error: string | null;
}

export const initialState: CanvasState = {
  nodes: [], edges: [], active: null, running: false, error: null,
};

/** Show the "Select Graph" call-to-action when nothing is loaded or a load failed. */
export function needsGraphSelection(state: CanvasState): boolean {
  return state.error !== null || (state.nodes.length === 0 && !state.running);
}

export function reduce(state: CanvasState, ev: ServerEvent): CanvasState {
  switch (ev.type) {
    case "graph":
      return { ...state, nodes: ev.nodes, edges: ev.edges, error: null };
    case "run_started":
      return { ...state, running: true, active: null };
    case "node_start":
      return { ...state, active: ev.node };
    case "node_end":
      return { ...state, active: state.active === ev.node ? null : state.active };
    case "run_finished":
      return { ...state, running: false, active: null };
    case "error":
      // graph_load_failed (and other sidecar errors) -> surface, don't blank-canvas.
      return { ...state, error: `${ev.code}: ${ev.message}`, running: false };
    default:
      return state;
  }
}
