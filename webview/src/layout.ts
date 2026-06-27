/**
 * Auto-layout via ELK (elk.js): layered top-to-bottom placement with ORTHOGONAL
 * edge routing. Unlike a positions-only layout (dagre), ELK returns each edge's
 * bend points routed to avoid nodes and minimise overlap/crossings — so we render
 * those exact routes and edges never overlap or cut through a node (the rule the
 * user set). Async (ELK runs its solver); pure + headless, unit-tested in layout.test.ts.
 */
import ELK from "elkjs/lib/elk.bundled.js";

export interface Size { w: number; h: number }
export interface Pt { x: number; y: number }
export type Pos = Record<string, Pt>;
export interface GraphLayout {
  pos: Pos;                          // node top-left positions
  routes: Record<string, Pt[]>;      // polyline per edge, keyed "src->tgt"
}

const elk = new ELK();

const OPTS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "56",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.edgeNode": "28",
  "elk.spacing.edgeEdge": "20",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
};

/** Run ELK and return node positions + orthogonal edge routes (in flow coordinates). */
export async function elkLayout(
  nodes: string[], edges: [string, string][], size: (n: string) => Size,
): Promise<GraphLayout> {
  if (nodes.length === 0) return { pos: {}, routes: {} };
  const graph = {
    id: "root",
    layoutOptions: OPTS,
    children: nodes.map((n) => ({ id: n, ...((s) => ({ width: s.w, height: s.h }))(size(n)) })),
    edges: edges.map(([s, t], i) => ({ id: `e${i}`, sources: [s], targets: [t] })),
  };
  const out = await elk.layout(graph);
  const pos: Pos = {};
  for (const c of out.children ?? []) {
    if (typeof c.x === "number" && typeof c.y === "number") pos[c.id] = { x: c.x, y: c.y };
  }
  const routes: Record<string, Pt[]> = {};
  ((out.edges ?? []) as Array<{ sections?: Array<{ startPoint: Pt; bendPoints?: Pt[]; endPoint: Pt }> }>)
    .forEach((e, i) => {
      const sec = e.sections?.[0];
      if (!sec) return;
      const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y }));
      const [s, t] = edges[i];
      routes[`${s}->${t}`] = pts;
    });
  return { pos, routes };
}
