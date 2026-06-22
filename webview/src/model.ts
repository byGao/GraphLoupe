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

export interface CanvasState {
  nodes: string[];
  edges: [string, string][];
  active: string | null;
  running: boolean;
  error: string | null;
  pending: ManualRequest | null;  // manual inference awaiting a pasted answer
}

export const initialState: CanvasState = {
  nodes: [], edges: [], active: null, running: false, error: null, pending: null,
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
      return { ...state, running: true, active: null };
    case "node_start":
      // a node (re)starting clears any prior pending manual request (resume re-run, P1)
      return { ...state, active: ev.node, pending: null };
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
      return { ...state, running: false, active: null, pending: null };
    case "error":
      // graph_load_failed (and other sidecar errors) -> surface, don't blank-canvas.
      return { ...state, error: `${ev.code}: ${ev.message}`, running: false };
    default:
      return state;
  }
}
