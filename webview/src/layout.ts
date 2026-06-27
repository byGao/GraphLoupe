/**
 * Auto-layout via dagre: layered top-to-bottom placement that handles branches,
 * multi-way switches and loops (back edges) cleanly — replacing the hand-rolled
 * two-lane layout whose fixed columns forced long folded edges. Pure + headless,
 * so it's unit-tested in layout.test.ts. React Flow only renders the positions.
 */
import dagre from "@dagrejs/dagre";

export interface Size { w: number; h: number }
export type Pos = Record<string, { x: number; y: number }>;

/** Top-left positions per node from a dagre TB layout. `size(n)` gives each node's
 *  rendered box so ranks don't overlap. dagre removes cycles internally, so back
 *  edges (loops) don't break ranking. */
export function dagreLayout(
  nodes: string[], edges: [string, string][], size: (n: string) => Size,
): Pos {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const { w, h } = size(n);
    g.setNode(n, { width: w, height: h });
  }
  for (const [s, t] of edges) {
    if (g.hasNode(s) && g.hasNode(t)) g.setEdge(s, t);
  }
  dagre.layout(g);
  const pos: Pos = {};
  for (const n of nodes) {
    const nd = g.node(n);
    if (nd) pos[n] = { x: nd.x - nd.width / 2, y: nd.y - nd.height / 2 };  // center -> top-left
  }
  return pos;
}
