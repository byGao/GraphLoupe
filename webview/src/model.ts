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
}

export const initialState: CanvasState = { nodes: [], edges: [], active: null, running: false };

export function reduce(state: CanvasState, ev: ServerEvent): CanvasState {
  switch (ev.type) {
    case "graph":
      return { ...state, nodes: ev.nodes, edges: ev.edges };
    case "run_started":
      return { ...state, running: true, active: null };
    case "node_start":
      return { ...state, active: ev.node };
    case "node_end":
      return { ...state, active: state.active === ev.node ? null : state.active };
    case "run_finished":
      return { ...state, running: false, active: null };
    default:
      return state;
  }
}
